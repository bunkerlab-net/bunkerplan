import { describe, expect, test } from "bun:test";
import type { AppAuth } from "../src/auth/instance.ts";
import { MAX_SHARE_CODE_LENGTH } from "../src/config.ts";
import {
  MAX_UNLOCK_BODY_BYTES,
  resolvePlanAccess,
  unlockPlan,
} from "../src/http/plan-access.ts";
import {
  hashShareCode,
  mintShareCookie,
  SHARE_COOKIE_TTL_SEC,
  shareCookieName,
} from "../src/http/share-auth.ts";
import type { PlanAccessRow, PlanRepo } from "../src/services/types.ts";

const OWNER = "user-owner";
const GRANTEE = "user-grantee";
const STRANGER = "user-stranger";
const PLAN = "abcdefgh12345678";
const CODE = "sHaReCoDe1234567";

const CONFIG = {
  secret: "plan-access-test-secret-0123456789",
  publicBaseUrl: "https://plans.example.test",
};

interface AuthCalls {
  sessions: number;
  keys: number;
}

/**
 * Only the two endpoints the resolver touches. `AppAuth` is Better Auth's
 * fully inferred plugin-aware type - hundreds of endpoints that cannot be
 * spelled out here - so this is the one place a cast is the honest option.
 */
function fakeAuth(
  over: { sessionUser?: string | null; keyUser?: string | null } = {},
): { auth: AppAuth; calls: AuthCalls } {
  const calls: AuthCalls = { sessions: 0, keys: 0 };
  const api = {
    getSession: async () => {
      calls.sessions += 1;
      const id = over.sessionUser ?? null;
      return id === null ? null : { user: { id } };
    },
    verifyApiKey: async () => {
      calls.keys += 1;
      const referenceId = over.keyUser ?? null;
      return referenceId === null
        ? { valid: false, key: null }
        : { valid: true, key: { referenceId } };
    },
  };
  return { auth: { api } as unknown as AppAuth, calls };
}

function fakePlans(
  row: PlanAccessRow | null,
  grantees: string[] = [],
): PlanRepo {
  return {
    insert: async () => "created",
    listByUser: async () => [],
    findOwner: async () => null,
    relabel: async () => false,
    resize: async () => false,
    deleteOwned: async () => false,
    findAccess: async (id) => (id === PLAN ? row : null),
    hasGrant: async (planId, userId) =>
      planId === PLAN && grantees.includes(userId),
    setVisibility: async () => false,
    setShareCodeHash: async () => false,
    listGrantHandles: async () => null,
    grantByHandle: async () => "no-plan",
    revokeByHandle: async () => false,
  };
}

function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://plans.example.test${url}`, { headers });
}

const publicRow = (): PlanAccessRow => ({
  ownerId: OWNER,
  visibility: "public",
  shareCodeHash: null,
});

async function codedRow(code = CODE): Promise<PlanAccessRow> {
  return {
    ownerId: OWNER,
    visibility: "private",
    shareCodeHash: await hashShareCode(code),
  };
}

const privateRow = (): PlanAccessRow => ({
  ownerId: OWNER,
  visibility: "private",
  shareCodeHash: null,
});

/** The cookie a browser would send back, from a freshly minted one. */
async function cookieFor(
  hash: string,
  over: { planId?: string; mintedAt?: number } = {},
): Promise<string> {
  const setCookie = await mintShareCookie(
    CONFIG,
    over.planId ?? PLAN,
    hash,
    over.mintedAt ?? Date.now(),
  );
  return setCookie.split(";")[0] ?? "";
}

describe("resolvePlanAccess", () => {
  test("an id this app could not have issued is missing, not gated", async () => {
    const { auth } = fakeAuth();
    // A gate on an unroutable id would confirm the shape of ids that exist.
    for (const bad of ["../etc", "UPPER", "with_underscore", ""]) {
      expect(
        await resolvePlanAccess(
          auth,
          fakePlans(null),
          CONFIG,
          get("/p/x"),
          bad,
        ),
      ).toEqual({ kind: "missing" });
    }
  });

  test("a plan with no row is missing", async () => {
    const { auth } = fakeAuth();
    expect(
      await resolvePlanAccess(auth, fakePlans(null), CONFIG, get("/p/x"), PLAN),
    ).toEqual({ kind: "missing" });
  });

  test("a public plan is granted without touching either credential", async () => {
    const { auth, calls } = fakeAuth({ sessionUser: OWNER, keyUser: OWNER });

    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(publicRow()),
        CONFIG,
        get("/p/x"),
        PLAN,
      ),
    ).toEqual({ kind: "granted", visibility: "public" });
    // The common case must stay one row read; a session lookup here would be
    // paid by every anonymous reader of every public plan.
    expect(calls).toEqual({ sessions: 0, keys: 0 });
  });

  test("a private plan with no credential is gated", async () => {
    const { auth } = fakeAuth();
    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(privateRow()),
        CONFIG,
        get("/p/x"),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: false });
  });

  test("the gate reports whether a code would help", async () => {
    const { auth } = fakeAuth();
    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(await codedRow()),
        CONFIG,
        get("/p/x"),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: true });
  });

  test("the owner is granted by session and by key", async () => {
    for (const [header, over] of [
      [{}, { sessionUser: OWNER }],
      [{ "x-api-key": "k" }, { keyUser: OWNER }],
    ] as const) {
      const { auth } = fakeAuth(over);
      expect(
        await resolvePlanAccess(
          auth,
          fakePlans(privateRow()),
          CONFIG,
          get("/p/x", header),
          PLAN,
        ),
      ).toEqual({ kind: "granted", visibility: "private" });
    }
  });

  test("a grantee is granted by either credential, and a stranger by neither", async () => {
    const plans = fakePlans(privateRow(), [GRANTEE]);

    // The gate authorises the user behind a credential, not a credential
    // type, so both routes to the same account must land the same way.
    const byKey = fakeAuth({ keyUser: GRANTEE });
    expect(
      await resolvePlanAccess(
        byKey.auth,
        plans,
        CONFIG,
        get("/p/x", { "x-api-key": "k" }),
        PLAN,
      ),
    ).toEqual({ kind: "granted", visibility: "private" });

    const bySession = fakeAuth({ sessionUser: GRANTEE });
    expect(
      await resolvePlanAccess(bySession.auth, plans, CONFIG, get("/p/x"), PLAN),
    ).toEqual({ kind: "granted", visibility: "private" });

    const refusedKey = fakeAuth({ keyUser: STRANGER });
    expect(
      await resolvePlanAccess(
        refusedKey.auth,
        plans,
        CONFIG,
        get("/p/x", { "x-api-key": "k" }),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: false });

    const refusedSession = fakeAuth({ sessionUser: STRANGER });
    expect(
      await resolvePlanAccess(
        refusedSession.auth,
        plans,
        CONFIG,
        get("/p/x"),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: false });
  });

  test("an x-api-key header never falls back to a session", async () => {
    // A browser never sends the header, so a key that fails verification is a
    // client using the wrong key - not one that also has a cookie to try.
    const { auth, calls } = fakeAuth({ sessionUser: OWNER, keyUser: null });

    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(privateRow()),
        CONFIG,
        get("/p/x", { "x-api-key": "wrong" }),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: false });
    expect(calls).toEqual({ sessions: 0, keys: 1 });
  });

  test("a valid ?code= grants and mints the cookie", async () => {
    const { auth, calls } = fakeAuth();
    const access = await resolvePlanAccess(
      auth,
      fakePlans(await codedRow()),
      CONFIG,
      get(`/p/x?code=${CODE}`),
      PLAN,
    );

    expect(access.kind).toBe("granted");
    if (access.kind !== "granted") return;
    expect(access.visibility).toBe("private");
    expect(access.setCookie).toContain(shareCookieName(PLAN));
    expect(access.setCookie).toContain(`Path=/p/${PLAN}`);
    // A code holder costs no credential lookup at all.
    expect(calls).toEqual({ sessions: 0, keys: 0 });
  });

  test("a wrong code falls through to the caller's own credential", async () => {
    // An owner following a stale link must still get in. Short-circuiting to
    // the gate on a bad code would lock them out of their own plan.
    const { auth } = fakeAuth({ sessionUser: OWNER });
    const access = await resolvePlanAccess(
      auth,
      fakePlans(await codedRow()),
      CONFIG,
      get("/p/x?code=stale-and-wrong"),
      PLAN,
    );

    expect(access).toEqual({ kind: "granted", visibility: "private" });
  });

  test("a wrong code with no credential is gated", async () => {
    const { auth } = fakeAuth();
    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(await codedRow()),
        CONFIG,
        get("/p/x?code=nope"),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: true });
  });

  test("a code past the ceiling is ignored without being hashed", async () => {
    // Bounded at the exported ceiling rather than the current setting, so
    // lowering SHARE_CODE_LENGTH cannot orphan codes already minted. Derived
    // from the constant, so raising the ceiling moves this test with it.
    const tooLong = "a".repeat(MAX_SHARE_CODE_LENGTH + 1);
    // The stored digest is this exact code, so a comparison that ran would
    // succeed. Gating anyway is what shows the length is checked first -
    // against `codedRow()`'s own code the request would be refused either
    // way, and the test would pass without the ceiling existing at all.
    const { auth } = fakeAuth();
    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(await codedRow(tooLong)),
        CONFIG,
        get(`/p/x?code=${tooLong}`),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: true });
  });

  test("a code exactly at the ceiling is still tested", async () => {
    const long = "b".repeat(MAX_SHARE_CODE_LENGTH);
    const { auth } = fakeAuth();
    const access = await resolvePlanAccess(
      auth,
      fakePlans(await codedRow(long)),
      CONFIG,
      get(`/p/x?code=${long}`),
      PLAN,
    );
    expect(access.kind).toBe("granted");
  });

  test("a valid cookie grants without a credential lookup", async () => {
    const row = await codedRow();
    const { auth, calls } = fakeAuth();

    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(row),
        CONFIG,
        get("/p/x", { cookie: await cookieFor(row.shareCodeHash ?? "") }),
        PLAN,
      ),
    ).toEqual({ kind: "granted", visibility: "private" });
    expect(calls).toEqual({ sessions: 0, keys: 0 });
  });

  test("a cookie minted for another plan does not carry over", async () => {
    const row = await codedRow();
    const { auth } = fakeAuth();
    const other = await mintShareCookie(
      CONFIG,
      "zzzzzzzz99999999",
      row.shareCodeHash ?? "",
      Date.now(),
    );
    // Renamed onto this plan: the signature verifies, the payload does not.
    const renamed = (other.split(";")[0] ?? "").replace(
      shareCookieName("zzzzzzzz99999999"),
      shareCookieName(PLAN),
    );

    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(row),
        CONFIG,
        get("/p/x", { cookie: renamed }),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: true });
  });

  test("a cookie minted under a rotated code is refused", async () => {
    const { auth } = fakeAuth();
    const stale = await cookieFor(await hashShareCode("the-old-code"));

    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(await codedRow("the-new-code")),
        CONFIG,
        get("/p/x", { cookie: stale }),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: true });
  });

  test("a cookie for a plan whose code was cleared grants nothing", async () => {
    // `shareCodeHash` is null, so the cookie branch is skipped entirely.
    const { auth } = fakeAuth();
    const orphan = await cookieFor(await hashShareCode(CODE));

    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(privateRow()),
        CONFIG,
        get("/p/x", { cookie: orphan }),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: false });
  });

  test("an expired cookie gates rather than granting", async () => {
    // The resolver must not trust a cookie merely because it verifies; the
    // TTL is inside the signed payload and only `verifyShareCookie` reads it.
    const row = await codedRow();
    const { auth } = fakeAuth();
    const stale = await cookieFor(row.shareCodeHash ?? "", {
      mintedAt: Date.now() - SHARE_COOKIE_TTL_SEC * 1000 - 1,
    });

    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(row),
        CONFIG,
        get("/p/x", { cookie: stale }),
        PLAN,
      ),
    ).toEqual({ kind: "gate", hasCode: true });
  });

  test("an expired cookie still lets the owner in on their own credential", async () => {
    const row = await codedRow();
    const { auth } = fakeAuth({ sessionUser: OWNER });
    const stale = await cookieFor(row.shareCodeHash ?? "", {
      mintedAt: Date.now() - SHARE_COOKIE_TTL_SEC * 1000 - 1,
    });

    expect(
      await resolvePlanAccess(
        auth,
        fakePlans(row),
        CONFIG,
        get("/p/x", { cookie: stale }),
        PLAN,
      ),
    ).toEqual({ kind: "granted", visibility: "private" });
  });
});

function post(body: string | null, planId = PLAN): Request {
  return new Request(`https://plans.example.test/api/plans/${planId}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === null ? {} : { body }),
  });
}

describe("unlockPlan", () => {
  test("a correct code answers 204 with the cookie", async () => {
    const row = await codedRow();
    const response = await unlockPlan(
      fakePlans(row),
      CONFIG,
      post(JSON.stringify({ code: CODE })),
      PLAN,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain(shareCookieName(PLAN));
  });

  /** `Response.json()` is untyped here; assertions need something to compare. */
  const jsonOf = async (response: Response): Promise<unknown> =>
    await response.json();

  test("a wrong code answers 401 and sets nothing", async () => {
    const response = await unlockPlan(
      fakePlans(await codedRow()),
      CONFIG,
      post(JSON.stringify({ code: "wrong" })),
      PLAN,
    );

    expect(response.status).toBe(401);
    expect(await jsonOf(response)).toEqual({ error: "invalid code" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test.each([
    ["no body", null],
    ["a non-JSON body", "not json"],
    ["a JSON array", "[]"],
    ["no code field", "{}"],
    ["a non-string code", '{"code":42}'],
    ["an empty code", '{"code":""}'],
    // Past MAX_UNLOCK_BODY_BYTES, so `readBoundedBody` refuses and returns
    // null. That collapses into the same 400 rather than a 413: the bound is
    // a defence on an unauthenticated route, not a second contract. Sized
    // from the constant, so raising the ceiling cannot leave this body under
    // the bound and the case quietly asserting nothing.
    [
      "a body too large to read",
      `{"code":"${"x".repeat(MAX_UNLOCK_BODY_BYTES + 1)}"}`,
    ],
  ])("%s is one 400", async (_, body) => {
    const response = await unlockPlan(
      fakePlans(await codedRow()),
      CONFIG,
      post(body),
      PLAN,
    );

    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({ error: "code is required" });
  });

  test("a plan with no code is indistinguishable from no plan", async () => {
    // Otherwise this endpoint reports which private plans are code-shared.
    const missing = await unlockPlan(
      fakePlans(null),
      CONFIG,
      post(JSON.stringify({ code: CODE })),
      PLAN,
    );
    const uncoded = await unlockPlan(
      fakePlans(privateRow()),
      CONFIG,
      post(JSON.stringify({ code: CODE })),
      PLAN,
    );

    expect(missing.status).toBe(404);
    expect(uncoded.status).toBe(404);
    expect(await jsonOf(missing)).toEqual(await jsonOf(uncoded));
  });

  test("an unroutable plan id is a 404, not a crash", async () => {
    const response = await unlockPlan(
      fakePlans(await codedRow()),
      CONFIG,
      post(JSON.stringify({ code: CODE }), "NOT-AN-ID"),
      "NOT-AN-ID",
    );
    expect(response.status).toBe(404);
  });
});
