import { describe, expect, test } from "bun:test";
import type { AppAuth } from "../src/auth/instance.ts";
import { MAX_GRANTS_PER_REQUEST } from "../src/http/account-list.ts";
import {
  clearShareCode,
  getPlanSharing,
  grantPlan,
  revokePlanGrant,
  rotateShareCode,
  setPlanSharing,
} from "../src/http/plan-sharing.ts";
import { hashShareCode } from "../src/http/share-auth.ts";
import type {
  GrantOutcome,
  PlanRepo,
  PlanVisibility,
} from "../src/services/types.ts";

const OWNER = "user-owner";
const PLAN = "abcdefgh12345678";
const HANDLE = "k7mjq2rvxn";

/**
 * `AppAuth` is Better Auth's fully inferred plugin-aware type - hundreds of
 * endpoints - so a structural fake needs the cast.
 *
 * `keyUser` is what makes the session-only assertions below mean anything: a
 * handler that reached for `resolveUserId` instead would resolve *this* and
 * succeed.
 */
function fakeAuth(
  sessionUser: string | null,
  keyUser: string | null = null,
): AppAuth {
  const api = {
    getSession: async () =>
      sessionUser === null ? null : { user: { id: sessionUser } },
    verifyApiKey: async () =>
      keyUser === null
        ? { valid: false, key: null }
        : { valid: true, key: { referenceId: keyUser } },
  };
  return { api } as unknown as AppAuth;
}

interface Calls {
  granted: { planId: string; ownerId: string; account: string }[];
  revoked: { planId: string; ownerId: string; account: string }[];
  /** Every value handed to `setShareCodeHash`; never a plaintext code. */
  hashes: (string | null)[];
  visibilities: PlanVisibility[];
}

function fakePlans(
  over: {
    outcome?: GrantOutcome;
    revokes?: boolean;
    /** False models a plan that does not exist or is not the caller's. */
    owned?: boolean;
    /** The one account whose grant errors, modelling a database blip. */
    throwsFor?: string;
  } = {},
): {
  plans: PlanRepo;
  calls: Calls;
} {
  const owned = over.owned ?? true;
  const calls: Calls = {
    granted: [],
    revoked: [],
    hashes: [],
    visibilities: [],
  };
  // Stateful, so a handler that answers with the new state is actually
  // checked against it rather than against a constant the fake would have
  // returned either way.
  const stored: { visibility: PlanVisibility; shareCodeHash: string | null } = {
    visibility: "private",
    shareCodeHash: null,
  };
  const granted = new Set<string>();
  const plans: PlanRepo = {
    insert: async () => "created",
    listByUser: async () => [],
    // `applyGrants` resolves ownership here before it touches a handle, so
    // this has to follow `owned` like the rest of the fake.
    findOwner: async () => (owned ? OWNER : null),
    relabel: async () => false,
    resize: async () => false,
    deleteOwned: async () => false,
    findAccess: async () => (owned ? { ownerId: OWNER, ...stored } : null),
    hasGrant: async () => false,
    setVisibility: async (_id, _userId, visibility) => {
      calls.visibilities.push(visibility);
      if (owned) stored.visibility = visibility;
      return owned;
    },
    setShareCodeHash: async (_id, _userId, hash) => {
      calls.hashes.push(hash);
      if (owned) stored.shareCodeHash = hash;
      return owned;
    },
    // Stateful, like `visibility` and `shareCodeHash` above: a handler that
    // reports the sharing state is then checked against what was actually
    // granted rather than against a constant the fake would have returned
    // whatever happened.
    listGrantHandles: async () => (owned ? [...granted] : null),
    grantByHandle: async (planId, ownerId, account) => {
      calls.granted.push({ planId, ownerId, account });
      if (account === over.throwsFor) throw new Error("database unreachable");
      const outcome = over.outcome ?? "granted";
      if (owned && outcome === "granted") granted.add(account);
      return outcome;
    },
    revokeByHandle: async (planId, ownerId, account) => {
      calls.revoked.push({ planId, ownerId, account });
      const revoked = over.revokes ?? true;
      if (revoked) granted.delete(account);
      return revoked;
    },
  };
  return { plans, calls };
}

function post(body: unknown): Request {
  return new Request(`https://plans.example.test/api/plans/${PLAN}/grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** `Response.json()` is untyped here; assertions need something to compare. */
const jsonOf = async (response: Response): Promise<unknown> =>
  await response.json();

const plain = (init: RequestInit = {}): Request =>
  new Request("https://plans.example.test/x", init);

describe("reading and setting the sharing state", () => {
  test("getPlanSharing reports the row and its grants", async () => {
    const { plans } = fakePlans();
    const response = await getPlanSharing(
      fakeAuth(OWNER),
      plans,
      plain(),
      PLAN,
    );

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({
      visibility: "private",
      hasShareCode: false,
      grants: [],
    });
  });

  test("getPlanSharing reports the accounts actually granted", async () => {
    // The empty case above passes against a fake that always answers `[]`,
    // so it says nothing about the handler carrying the list through.
    const { plans } = fakePlans();
    await grantPlan(fakeAuth(OWNER), plans, post({ accounts: "a,b,c" }), PLAN);
    await revokePlanGrant(fakeAuth(OWNER), plans, plain(), PLAN, "b");

    const response = await getPlanSharing(
      fakeAuth(OWNER),
      plans,
      plain(),
      PLAN,
    );

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({
      visibility: "private",
      hasShareCode: false,
      grants: ["a", "c"],
    });
  });

  test("setPlanSharing stores the value and answers the new state", async () => {
    const { plans, calls } = fakePlans();
    const response = await setPlanSharing(
      fakeAuth(OWNER),
      plans,
      post({ visibility: "public" }),
      PLAN,
    );

    expect(response.status).toBe(200);
    expect(calls.visibilities).toEqual(["public"]);
    // The response is the new state, not the state as it was read on the way
    // in - the dashboard renders the row straight from this.
    expect(await jsonOf(response)).toEqual({
      visibility: "public",
      hasShareCode: false,
      grants: [],
    });
  });

  test("setPlanSharing refuses a value the column cannot hold", async () => {
    const { plans, calls } = fakePlans();
    const response = await setPlanSharing(
      fakeAuth(OWNER),
      plans,
      post({ visibility: "code" }),
      PLAN,
    );

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({
      error: "visibility must be public or private",
    });
    expect(calls.visibilities).toEqual([]);
  });

  test("setPlanSharing refuses a body that is not JSON", async () => {
    const { plans, calls } = fakePlans();
    const response = await setPlanSharing(
      fakeAuth(OWNER),
      plans,
      post(undefined),
      PLAN,
    );

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({ error: "body must be JSON" });
    expect(calls.visibilities).toEqual([]);
  });

  test("setPlanSharing refuses a body too large to be a visibility", async () => {
    const { plans, calls } = fakePlans();
    const response = await setPlanSharing(
      fakeAuth(OWNER),
      plans,
      post({ visibility: "public", padding: "x".repeat(4096) }),
      PLAN,
    );

    expect(response.status).toBe(413);
    expect(calls.visibilities).toEqual([]);
  });
});

describe("the share code", () => {
  test("rotateShareCode returns the plaintext and stores only a digest", async () => {
    const { plans, calls } = fakePlans();
    const response = await rotateShareCode(
      fakeAuth(OWNER),
      plans,
      { shareCodeLength: 16 },
      plain({ method: "POST" }),
      PLAN,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { code: string };
    expect(body.code).toMatch(/^[0-9A-Za-z]{16}$/);

    // The whole point of the column: what the caller is handed and what the
    // repository is handed must not be the same string.
    expect(calls.hashes).toEqual([await hashShareCode(body.code)]);
    expect(calls.hashes[0]).not.toBe(body.code);
  });

  test("rotateShareCode honours the deployment's configured length", async () => {
    const { plans } = fakePlans();
    const response = await rotateShareCode(
      fakeAuth(OWNER),
      plans,
      { shareCodeLength: 32 },
      plain({ method: "POST" }),
      PLAN,
    );

    expect(((await response.json()) as { code: string }).code).toHaveLength(32);
  });

  test("clearShareCode stores null", async () => {
    const { plans, calls } = fakePlans();
    const response = await clearShareCode(
      fakeAuth(OWNER),
      plans,
      plain({ method: "DELETE" }),
      PLAN,
    );

    expect(response.status).toBe(204);
    expect(calls.hashes).toEqual([null]);
  });
});

/**
 * Not 403, and not a distinct message: the plan API never confirms that
 * someone else's id exists. Each of these is the repository reporting "no row
 * matched your id and your ownership".
 */
describe("a plan the caller does not own is a 404", () => {
  test.each([
    [
      "getPlanSharing",
      (plans: PlanRepo) =>
        getPlanSharing(fakeAuth(OWNER), plans, plain(), PLAN),
    ],
    [
      "setPlanSharing",
      (plans: PlanRepo) =>
        setPlanSharing(
          fakeAuth(OWNER),
          plans,
          post({ visibility: "public" }),
          PLAN,
        ),
    ],
    [
      "rotateShareCode",
      (plans: PlanRepo) =>
        rotateShareCode(
          fakeAuth(OWNER),
          plans,
          { shareCodeLength: 16 },
          plain({ method: "POST" }),
          PLAN,
        ),
    ],
    [
      "clearShareCode",
      (plans: PlanRepo) =>
        clearShareCode(
          fakeAuth(OWNER),
          plans,
          plain({ method: "DELETE" }),
          PLAN,
        ),
    ],
  ])("%s", async (_, run) => {
    const { plans } = fakePlans({ owned: false });
    const response = await run(plans);

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({ error: "not found" });
  });
});

describe("grantPlan", () => {
  test("grants one handle and reports it", async () => {
    const { plans, calls } = fakePlans();
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: HANDLE }),
      PLAN,
    );

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({
      granted: [HANDLE],
      unknown: [],
      failed: [],
    });
    expect(calls.granted).toEqual([
      { planId: PLAN, ownerId: OWNER, account: HANDLE },
    ]);
  });

  test("splits a comma-separated list into one grant each", async () => {
    // The whole point of the field: naming five colleagues is one request,
    // not five.
    const { plans, calls } = fakePlans();
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: `${HANDLE}, second , third` }),
      PLAN,
    );

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({
      granted: [HANDLE, "second", "third"],
      unknown: [],
      failed: [],
    });
    expect(calls.granted.map((call) => call.account)).toEqual([
      HANDLE,
      "second",
      "third",
    ]);
  });

  test("takes an array as readily as a string", async () => {
    const { plans, calls } = fakePlans();
    await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: [`${HANDLE},second`, " third "] }),
      PLAN,
    );

    expect(calls.granted.map((call) => call.account)).toEqual([
      HANDLE,
      "second",
      "third",
    ]);
  });

  test("collapses a repeated handle rather than reporting it twice", async () => {
    const { plans, calls } = fakePlans();
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: `${HANDLE}, ${HANDLE}` }),
      PLAN,
    );

    expect(await jsonOf(response)).toEqual({
      granted: [HANDLE],
      unknown: [],
      failed: [],
    });
    expect(calls.granted).toHaveLength(1);
  });

  test("skips blank entries a trailing comma leaves behind", async () => {
    const { plans, calls } = fakePlans();
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: `${HANDLE},,` }),
      PLAN,
    );

    expect(response.status).toBe(200);
    expect(calls.granted.map((call) => call.account)).toEqual([HANDLE]);
  });

  test("an unknown handle is reported, not fatal", async () => {
    // One mistyped name must not refuse the rest: the owner would have to
    // work out which of five it was.
    const { plans } = fakePlans({ outcome: "no-user" });
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: `${HANDLE},second` }),
      PLAN,
    );

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({
      granted: [],
      unknown: [HANDLE, "second"],
      failed: [],
    });
  });

  test("an account whose grant errors is reported, and the rest still land", async () => {
    // The upload route calls this after the plan is already durable, so a
    // throw here would answer 500 for a plan that exists. Every account has
    // to come back in one of the three buckets instead.
    const { plans, calls } = fakePlans({ throwsFor: "second" });
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: `${HANDLE},second,third` }),
      PLAN,
    );

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({
      granted: [HANDLE, "third"],
      unknown: [],
      failed: ["second"],
    });
    // It kept going rather than stopping at the one that threw.
    expect(calls.granted).toHaveLength(3);
  });

  test("a plan the caller does not own is a 404, before any handle", async () => {
    // The security property: `grantByHandle` resolves the handle before the
    // plan, so a stranger naming a handle that does not exist would get a 200
    // describing their typo unless ownership is settled first.
    const { plans, calls } = fakePlans({ owned: false });
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: `${HANDLE},second,third` }),
      PLAN,
    );

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({ error: "not found" });
    expect(calls.granted).toEqual([]);
  });

  test("a plan deleted mid-request is the same 404, and stops there", async () => {
    const { plans, calls } = fakePlans({ outcome: "no-plan" });
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: `${HANDLE},second,third` }),
      PLAN,
    );

    expect(response.status).toBe(404);
    // Stopped at the first, rather than asking three times about a plan that
    // has gone.
    expect(calls.granted).toHaveLength(1);
  });

  test("refuses more handles than one request may carry", async () => {
    const { plans, calls } = fakePlans();
    const many = Array.from(
      { length: MAX_GRANTS_PER_REQUEST + 1 },
      (_, index) => `handle${index}`,
    ).join(",");
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: many }),
      PLAN,
    );

    expect(response.status).toBe(400);
    expect(calls.granted).toEqual([]);
  });

  test.each([
    ["no handles field", {}],
    ["a null list", { accounts: null }],
    ["a numeric list", { accounts: 42 }],
    ["an array holding a non-string", { accounts: ["ok", 7] }],
    ["an empty string", { accounts: "" }],
    ["a whitespace-only string", { accounts: "   " }],
    ["only commas", { accounts: ",,," }],
    ["an empty array", { accounts: [] }],
    ["a JSON array body", []],
  ])("refuses %s without touching the repository", async (_, body) => {
    const { plans, calls } = fakePlans();
    const response = await grantPlan(fakeAuth(OWNER), plans, post(body), PLAN);

    expect(response.status).toBe(400);
    expect(calls.granted).toEqual([]);
  });

  test("a body that is not JSON says so, as the label route does", async () => {
    // A shape failure and a parse failure are different mistakes, and the
    // caller fixes them differently. `unlockPlan` collapses both on purpose -
    // its only caller is the gate page - but this one is written against by
    // hand.
    const { plans, calls } = fakePlans();
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post(undefined),
      PLAN,
    );

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({ error: "body must be JSON" });
    expect(calls.granted).toEqual([]);
  });

  test("refuses a body too large to be a handle", async () => {
    // Unbounded parsing on a route that only ever carries ten characters.
    const { plans, calls } = fakePlans();
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: "x".repeat(4096) }),
      PLAN,
    );

    expect(response.status).toBe(413);
    expect(calls.granted).toEqual([]);
  });
});

describe("revokePlanGrant", () => {
  const del = () =>
    new Request(
      `https://plans.example.test/api/plans/${PLAN}/grants/${HANDLE}`,
      { method: "DELETE" },
    );

  test("passes the path handle through and answers 204", async () => {
    const { plans, calls } = fakePlans();
    const response = await revokePlanGrant(
      fakeAuth(OWNER),
      plans,
      del(),
      PLAN,
      HANDLE,
    );

    expect(response.status).toBe(204);
    expect(calls.revoked).toEqual([
      { planId: PLAN, ownerId: OWNER, account: HANDLE },
    ]);
  });

  test("a handle that held no grant is a 404, not a silent success", async () => {
    const { plans } = fakePlans({ revokes: false });
    const response = await revokePlanGrant(
      fakeAuth(OWNER),
      plans,
      del(),
      PLAN,
      HANDLE,
    );

    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toEqual({ error: "not found" });
  });
});

/**
 * The security property this module exists to hold. An API key already reads,
 * replaces, and deletes its owner's plans; letting it also hand access to
 * other people would turn a leaked key from a data-loss problem into a
 * persistent backdoor.
 *
 * Every request below carries a key that verifies to the plan's own owner, and
 * no session. A handler that resolved `resolveUserId` rather than
 * `resolveSessionUserId` would authorise all of them.
 */
describe("every sharing handler refuses an API key", () => {
  const keyOnly = fakeAuth(null, OWNER);
  // Headers typed as a plain record, not `HeadersInit`: the spread below adds
  // the key, and spreading a `Headers` instance would silently yield `{}`.
  const keyed = (
    init: Omit<RequestInit, "headers"> & {
      headers?: Record<string, string>;
    } = {},
  ): Request =>
    new Request("https://plans.example.test/x", {
      ...init,
      headers: { ...(init.headers ?? {}), "x-api-key": "bkp_valid" },
    });
  const keyedJson = (body: unknown): Request =>
    keyed({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test.each([
    [
      "getPlanSharing",
      (plans: PlanRepo) => getPlanSharing(keyOnly, plans, keyed(), PLAN),
    ],
    [
      "setPlanSharing",
      (plans: PlanRepo) =>
        setPlanSharing(
          keyOnly,
          plans,
          keyedJson({ visibility: "public" }),
          PLAN,
        ),
    ],
    [
      "rotateShareCode",
      (plans: PlanRepo) =>
        rotateShareCode(
          keyOnly,
          plans,
          { shareCodeLength: 16 },
          keyed({ method: "POST" }),
          PLAN,
        ),
    ],
    [
      "clearShareCode",
      (plans: PlanRepo) =>
        clearShareCode(keyOnly, plans, keyed({ method: "DELETE" }), PLAN),
    ],
    [
      "grantPlan",
      (plans: PlanRepo) =>
        grantPlan(keyOnly, plans, keyedJson({ accounts: HANDLE }), PLAN),
    ],
    [
      "revokePlanGrant",
      (plans: PlanRepo) =>
        revokePlanGrant(
          keyOnly,
          plans,
          keyed({ method: "DELETE" }),
          PLAN,
          HANDLE,
        ),
    ],
  ])("%s refuses a valid key and changes nothing", async (_, run) => {
    const { plans, calls } = fakePlans();
    const response = await run(plans);

    expect(response.status).toBe(401);
    expect(await jsonOf(response)).toEqual({
      error: "authentication required",
    });
    // Nothing reached the repository: not a grant, not a revoke, and not a
    // write of either column.
    expect(calls).toEqual({
      granted: [],
      revoked: [],
      hashes: [],
      visibilities: [],
    });
  });

  test.each([
    [
      "getPlanSharing",
      (plans: PlanRepo, r: Request) =>
        getPlanSharing(fakeAuth(null), plans, r, PLAN),
    ],
    [
      "grantPlan",
      (plans: PlanRepo, r: Request) =>
        grantPlan(fakeAuth(null), plans, r, PLAN),
    ],
  ])("%s refuses a caller with no credential at all", async (_, run) => {
    const { plans } = fakePlans();
    const response = await run(
      plans,
      new Request("https://plans.example.test/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accounts: HANDLE }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
