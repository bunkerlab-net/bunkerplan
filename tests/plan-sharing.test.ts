import { describe, expect, test } from "bun:test";
import type { AppAuth } from "../src/auth/instance.ts";
import {
  clearShareCode,
  getPlanSharing,
  grantPlan,
  revokePlanGrant,
  rotateShareCode,
  setPlanSharing,
} from "../src/http/plan-sharing.ts";
import { hashShareCode } from "../src/http/share-auth.ts";
import { MAX_GRANTS_PER_REQUEST, type PlanVisibility } from "../src/limits.ts";
import type { GrantOutcome, PlanRepo } from "../src/services/types.ts";
import {
  memoryPlans,
  OWNER,
  PLAN_ID as PLAN,
  fakeAuth as sharedAuth,
  storedPlan,
} from "./fakes.ts";

const HANDLE = "k7mjq2rvxn";

/**
 * `keyUser` is what makes the session-only assertions below mean anything: a
 * handler that reached for `resolveUserId` instead would resolve *this* and
 * succeed. The counts the shared fake keeps are not used here - `calls` below
 * records repository traffic, which is what these handlers are judged on.
 */
function fakeAuth(
  sessionUser: string | null,
  keyUser: string | null = null,
): AppAuth {
  return sharedAuth({ sessionUser, keyUser }).auth;
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
    /**
     * What `grantByHandle` answers. A function lets one request mix
     * outcomes, which is the only way to show that an unknown account does
     * not take the valid ones down with it.
     */
    outcome?: GrantOutcome | ((account: string) => GrantOutcome);
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
  /*
   * The shared repository holds the state - visibility, the share digest,
   * ownership - so a handler that answers with the new state is checked
   * against what was actually written rather than against a constant.
   * `owned: false` is simply the empty repository, which is what "no row
   * matched your id and your ownership" is.
   *
   * `calls.visibilities` and `calls.hashes` are the other half, and they
   * record attempts rather than writes: the push happens before the delegate
   * runs, so a value the repository refuses - a code minted against a public
   * plan, a write to a row the caller does not own - is in the list all the
   * same. That is what makes them useful, since "the handler tried to do this
   * and was told no" is a case worth asserting. What was actually stored is
   * read back off `memory` instead.
   */
  const memory = memoryPlans(
    owned ? [storedPlan({ id: PLAN, userId: OWNER })] : [],
  );
  const granted = new Set<string>();
  const plans: PlanRepo = {
    ...memory,
    setVisibility: async (id, userId, visibility) => {
      calls.visibilities.push(visibility);
      return await memory.setVisibility(id, userId, visibility);
    },
    setShareCodeHash: async (id, userId, hash) => {
      calls.hashes.push(hash);
      return await memory.setShareCodeHash(id, userId, hash);
    },
    /*
     * Grants are staged here rather than through the shared repository's
     * handle table: these cases name arbitrary handles by the dozen and pick
     * the outcome per account, which is the whole point of the suite. The
     * list stays stateful so a handler reporting the sharing state is checked
     * against what was actually granted.
     */
    listGrantHandles: async () => (owned ? [...granted] : null),
    grantByHandle: async (planId, ownerId, account) => {
      calls.granted.push({ planId, ownerId, account });
      if (account === over.throwsFor) throw new Error("database unreachable");
      const outcome =
        typeof over.outcome === "function"
          ? over.outcome(account)
          : (over.outcome ?? "granted");
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

  test("an unknown handle is reported, and the rest still land", async () => {
    // One mistyped name must not refuse the rest: the owner would have to
    // work out which of five it was. Outcomes vary by account, because a
    // fake that answered "no-user" to everything would leave `granted`
    // empty and prove nothing about the split.
    const { plans } = fakePlans({
      outcome: (account) => (account === HANDLE ? "no-user" : "granted"),
    });
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: `${HANDLE},second` }),
      PLAN,
    );

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({
      granted: ["second"],
      unknown: [HANDLE],
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

  const handleList = (count: number): string =>
    Array.from({ length: count }, (_, index) => `handle${index}`).join(",");

  test("accepts exactly as many handles as one request may carry", async () => {
    // The passing side of the boundary. Without it an off-by-one that
    // refused the last allowed account would look like the test below
    // working.
    const { plans, calls } = fakePlans();
    const wanted = handleList(MAX_GRANTS_PER_REQUEST).split(",");
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: wanted.join(",") }),
      PLAN,
    );

    expect(response.status).toBe(200);
    // The buckets, not just the call count: a handler that asked the
    // repository and then dropped the answers would pass on calls alone.
    expect(await jsonOf(response)).toEqual({
      granted: wanted,
      unknown: [],
      failed: [],
    });
    expect(calls.granted).toHaveLength(MAX_GRANTS_PER_REQUEST);
  });

  test("refuses more handles than one request may carry", async () => {
    const { plans, calls } = fakePlans();
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ accounts: handleList(MAX_GRANTS_PER_REQUEST + 1) }),
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
