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
import type { GrantOutcome, PlanRepo } from "../src/services/types.ts";

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
  granted: { planId: string; ownerId: string; handle: string }[];
  revoked: { planId: string; ownerId: string; handle: string }[];
}

function fakePlans(over: { outcome?: GrantOutcome; revokes?: boolean } = {}): {
  plans: PlanRepo;
  calls: Calls;
} {
  const calls: Calls = { granted: [], revoked: [] };
  const plans: PlanRepo = {
    insert: async () => "created",
    listByUser: async () => [],
    findOwner: async () => null,
    relabel: async () => false,
    resize: async () => false,
    deleteOwned: async () => false,
    findAccess: async () => ({
      ownerId: OWNER,
      visibility: "private",
      shareCodeHash: null,
    }),
    hasGrant: async () => false,
    setVisibility: async () => true,
    setShareCodeHash: async () => true,
    listGrantHandles: async () => [],
    grantByHandle: async (planId, ownerId, handle) => {
      calls.granted.push({ planId, ownerId, handle });
      return over.outcome ?? "granted";
    },
    revokeByHandle: async (planId, ownerId, handle) => {
      calls.revoked.push({ planId, ownerId, handle });
      return over.revokes ?? true;
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

describe("grantPlan", () => {
  test("passes the handle through and answers 204", async () => {
    const { plans, calls } = fakePlans();
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ handle: HANDLE }),
      PLAN,
    );

    expect(response.status).toBe(204);
    expect(calls.granted).toEqual([
      { planId: PLAN, ownerId: OWNER, handle: HANDLE },
    ]);
  });

  test("trims the handle before it reaches the repository", async () => {
    // A handle is copied out of a chat message as often as it is typed, so it
    // arrives with whitespace. Untrimmed it would miss the `user.email`
    // equality the grant is resolved by and report "no such account" for an
    // account that plainly exists.
    const { plans, calls } = fakePlans();
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ handle: `  ${HANDLE}\n` }),
      PLAN,
    );

    expect(response.status).toBe(204);
    expect(calls.granted[0]?.handle).toBe(HANDLE);
  });

  test.each([
    ["granted", 204, null],
    ["no-user", 404, { error: "no such account" }],
    ["no-plan", 404, { error: "not found" }],
  ] as const)("maps %s to %i", async (outcome, status, body) => {
    const { plans } = fakePlans({ outcome });
    const response = await grantPlan(
      fakeAuth(OWNER),
      plans,
      post({ handle: HANDLE }),
      PLAN,
    );

    expect(response.status).toBe(status);
    if (body !== null) expect(await jsonOf(response)).toEqual(body);
  });

  test.each([
    ["no handle field", {}],
    ["a null handle", { handle: null }],
    ["a non-string handle", { handle: 42 }],
    ["an empty handle", { handle: "" }],
    ["a whitespace-only handle", { handle: "   " }],
    ["a JSON array", []],
  ])("refuses %s without touching the repository", async (_, body) => {
    const { plans, calls } = fakePlans();
    const response = await grantPlan(fakeAuth(OWNER), plans, post(body), PLAN);

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({ error: "handle is required" });
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
      post({ handle: "x".repeat(4096) }),
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
      { planId: PLAN, ownerId: OWNER, handle: HANDLE },
    ]);
  });

  test("a handle that held no grant is a 404, not a silent success", async () => {
    const { plans } = fakePlans({ revokes: false });
    const response = await revokePlanGrant(
      fakeAuth(OWNER),
      plans,
      del(),
      PLAN,
      "nobodyatall",
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
  const keyed = (init: RequestInit = {}): Request =>
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
        grantPlan(keyOnly, plans, keyedJson({ handle: HANDLE }), PLAN),
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
    expect(calls).toEqual({ granted: [], revoked: [] });
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
        body: JSON.stringify({ handle: HANDLE }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
