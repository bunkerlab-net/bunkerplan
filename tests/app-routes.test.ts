import { describe, expect, test } from "bun:test";
import { PAGE_PROPS_ID } from "../src/client/mount.ts";
import { hashShareCode, shareCookieName } from "../src/http/share-auth.ts";
import { PLAN_PAGE_SIZE } from "../src/services/types.ts";
import {
  buildApp,
  CLIENT_IP,
  CLIENT_IP_HEADER,
  closedRateLimits,
  GRANTEE,
  html,
  memoryPlans,
  memoryStorage,
  OWNER,
  PLAN_ID,
  PUBLIC_BASE_URL,
  STRANGER,
  storedPlan,
  upload,
} from "./app-harness.ts";

/**
 * Every route the app answers, driven through the real router in this process.
 *
 * The e2e suite already proves the happy paths against the real Worker; what
 * this adds is the wiring itself - which credential each route accepts, what
 * an unknown path answers with, and the security headers the middleware pins
 * on the way out. Those are properties of `createApp` rather than of any one
 * handler, and a handler test cannot see them.
 */

const OK_HTML = html();

describe("the plan collection", () => {
  test("uploading takes an API key", async () => {
    const app = buildApp({ keyUser: OWNER });

    const response = await app.fetch("/api/plans", {
      ...upload(OK_HTML),
      headers: { "content-type": "text/html", "x-api-key": "bkp_test" },
    });

    expect(response.status).toBe(201);
    expect(app.auth.keys).toBe(1);
    // A key never mints a session, so the session path is not touched.
    expect(app.auth.sessions).toBe(0);
  });

  test("uploading takes a session too", async () => {
    const app = buildApp({ sessionUser: OWNER });

    const response = await app.fetch("/api/plans", upload(OK_HTML));

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; url: string };
    expect(body.url).toBe(`${PUBLIC_BASE_URL}/p/${body.id}`);
  });

  test("an anonymous upload is refused", async () => {
    const app = buildApp();

    const response = await app.fetch("/api/plans", upload(OK_HTML));

    expect(response.status).toBe(401);
  });

  test("a rejected document names what was wrong with it", async () => {
    const app = buildApp({ sessionUser: OWNER });

    const response = await app.fetch(
      "/api/plans",
      upload(html('<script src="https://evil.example/x.js"></script>')),
    );

    expect(response.status).toBe(422);
    // One fault, so the body carries `error` alone; `errors` appears only when
    // the validator listed more than one.
    const body = (await response.json()) as {
      error: string;
      errors?: string[];
    };
    expect(body.error).toContain("script");
    expect(body.errors).toBeUndefined();
  });

  test("an exhausted upload budget is refused and stores nothing", async () => {
    const app = buildApp({
      sessionUser: OWNER,
      uploadRateLimits: closedRateLimits,
    });

    const response = await app.fetch("/api/plans", upload(OK_HTML));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(app.storage.objects.size).toBe(0);
    // That the refusal comes *before* the body is read is pinned in
    // tests/create-plan.test.ts, which can watch the reader itself.
  });

  test("listing is session-only, because enumerating is not a per-plan act", async () => {
    const app = buildApp({ keyUser: OWNER });

    const response = await app.fetch("/api/plans", {
      headers: { "x-api-key": "bkp_test" },
    });

    expect(response.status).toBe(401);
    // A key can read one plan at a time through the gate; it cannot enumerate.
    expect(app.auth.keys).toBe(0);
  });

  test("listing returns the account's own plans, newest first", async () => {
    const plans = memoryPlans([
      storedPlan({
        id: "aaaaaaaaaaaaaaaa",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        label: "older",
      }),
      storedPlan({
        id: "bbbbbbbbbbbbbbbb",
        createdAt: new Date("2026-02-01T00:00:00Z"),
        visibility: "public",
      }),
      storedPlan({ id: "cccccccccccccccc", userId: STRANGER }),
    ]);
    const app = buildApp({ sessionUser: OWNER, plans });

    const response = await app.fetch("/api/plans");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      plans: Array<{ id: string; url: string; visibility: string }>;
      truncated: boolean;
    };
    expect(body.plans.map((row) => row.id)).toEqual([
      "bbbbbbbbbbbbbbbb",
      "aaaaaaaaaaaaaaaa",
    ]);
    expect(body.plans[0]?.url).toBe(`${PUBLIC_BASE_URL}/p/bbbbbbbbbbbbbbbb`);
    expect(body.plans[0]?.visibility).toBe("public");
    expect(body.truncated).toBe(false);
  });

  test("an anonymous list is refused", async () => {
    const response = await buildApp().fetch("/api/plans");

    expect(response.status).toBe(401);
  });

  test("a full page says so rather than silently returning a short list", async () => {
    // One row more than the page size is what `truncated` reports on; the
    // page itself is capped at the fixed size, never at the quota.
    const plans = {
      ...memoryPlans(),
      listByUser: async (_userId: string, limit: number) =>
        Array.from({ length: limit }, (_, index) => ({
          id: `plan${index}`,
          label: null,
          size: 1,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          visibility: "private" as const,
          hasShareCode: false,
        })),
    };
    const app = buildApp({ sessionUser: OWNER, plans });

    const response = await app.fetch("/api/plans");
    const body = (await response.json()) as {
      plans: unknown[];
      truncated: boolean;
    };

    expect(body.truncated).toBe(true);
    expect(body.plans.length).toBe(PLAN_PAGE_SIZE);
  });
});

describe("one plan by id", () => {
  const seeded = () =>
    buildApp({
      sessionUser: OWNER,
      plans: memoryPlans([storedPlan()]),
      storage: memoryStorage({ [PLAN_ID]: "<p>v1</p>" }),
    });

  test("replacing keeps the id and takes a key", async () => {
    const app = buildApp({
      keyUser: OWNER,
      plans: memoryPlans([storedPlan()]),
      storage: memoryStorage({ [PLAN_ID]: "<p>v1</p>" }),
    });

    const response = await app.fetch(`/api/plans/${PLAN_ID}`, {
      ...upload(html("<p>v2</p>")),
      headers: { "content-type": "text/html", "x-api-key": "bkp_test" },
    });

    expect(response.status).toBe(200);
    expect(
      new TextDecoder().decode(app.storage.objects.get(PLAN_ID)),
    ).toContain("<p>v2</p>");
  });

  test("an anonymous replace is refused", async () => {
    const app = buildApp({ plans: memoryPlans([storedPlan()]) });

    const response = await app.fetch(
      `/api/plans/${PLAN_ID}`,
      upload(html("<p>v2</p>")),
    );

    expect(response.status).toBe(401);
  });

  test("replacing counts against the upload budget", async () => {
    const app = buildApp({
      sessionUser: OWNER,
      plans: memoryPlans([storedPlan()]),
      uploadRateLimits: closedRateLimits,
    });

    const response = await app.fetch(
      `/api/plans/${PLAN_ID}`,
      upload(html("<p>v2</p>")),
    );

    expect(response.status).toBe(429);
  });

  test("another account's id 404s and its object is never touched", async () => {
    const app = buildApp({
      sessionUser: STRANGER,
      plans: memoryPlans([storedPlan()]),
      storage: memoryStorage({ [PLAN_ID]: "<p>v1</p>" }),
    });

    const response = await app.fetch(
      `/api/plans/${PLAN_ID}`,
      upload(html("<p>v2</p>")),
    );

    expect(response.status).toBe(404);
    expect(new TextDecoder().decode(app.storage.objects.get(PLAN_ID))).toBe(
      "<p>v1</p>",
    );
  });

  test("relabelling is session-only, unlike replace and delete", async () => {
    const app = buildApp({
      keyUser: OWNER,
      plans: memoryPlans([storedPlan()]),
    });

    const response = await app.fetch(`/api/plans/${PLAN_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-api-key": "bkp_test" },
      body: JSON.stringify({ label: "Q3" }),
    });

    // The label a key can set is the one it supplies on upload.
    expect(response.status).toBe(401);
  });

  test("relabelling with a session works", async () => {
    const app = seeded();

    const response = await app.fetch(`/api/plans/${PLAN_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Q3" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json<unknown>()).toEqual({
      id: PLAN_ID,
      label: "Q3",
    });
    const listed = await (await app.fetch("/api/plans")).json();
    expect(
      (listed as { plans: Array<{ label: string }> }).plans[0]?.label,
    ).toBe("Q3");
  });

  test("deleting takes a key and removes the object", async () => {
    const app = buildApp({
      keyUser: OWNER,
      plans: memoryPlans([storedPlan()]),
      storage: memoryStorage({ [PLAN_ID]: "<p>v1</p>" }),
    });

    const response = await app.fetch(`/api/plans/${PLAN_ID}`, {
      method: "DELETE",
      headers: { "x-api-key": "bkp_test" },
    });

    expect(response.status).toBe(204);
    expect(app.storage.objects.has(PLAN_ID)).toBe(false);
  });

  test("an anonymous delete is refused", async () => {
    const app = buildApp({ plans: memoryPlans([storedPlan()]) });

    const response = await app.fetch(`/api/plans/${PLAN_ID}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(401);
  });
});

describe("sharing", () => {
  const shared = (over: Parameters<typeof storedPlan>[0] = {}) =>
    buildApp({
      sessionUser: OWNER,
      plans: memoryPlans([storedPlan(over)], {
        "brisk-heron": GRANTEE,
      }),
    });

  test("reading the sharing state", async () => {
    const app = shared({ grants: [GRANTEE] });

    const response = await app.fetch(`/api/plans/${PLAN_ID}/sharing`);

    expect(response.status).toBe(200);
    expect(await response.json<unknown>()).toEqual({
      visibility: "private",
      hasShareCode: false,
      grants: ["brisk-heron"],
    });
  });

  test("sharing is session-only, so a key cannot widen a plan", async () => {
    const app = buildApp({
      keyUser: OWNER,
      plans: memoryPlans([storedPlan()]),
    });

    const response = await app.fetch(`/api/plans/${PLAN_ID}/sharing`, {
      headers: { "x-api-key": "bkp_test" },
    });

    expect(response.status).toBe(401);
  });

  test("making a plan public", async () => {
    const app = shared();

    const response = await app.fetch(`/api/plans/${PLAN_ID}/sharing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json<unknown>()).toMatchObject({
      visibility: "public",
    });
  });

  test("minting a code returns the plaintext once", async () => {
    const app = shared();

    const response = await app.fetch(`/api/plans/${PLAN_ID}/share-code`, {
      method: "POST",
    });

    expect(response.status).toBe(201);
    const { code } = (await response.json()) as { code: string };
    // Spelled out rather than `[0-9a-z]` with an `i` flag: the generator's
    // alphabet is base62 (src/ids.ts), which keeps case deliberately for the
    // entropy, so mixed case is the contract and not an accident of matching.
    expect(code).toMatch(/^[0-9A-Za-z]{16}$/);

    // There is no endpoint that reads it back.
    const state = await (
      await app.fetch(`/api/plans/${PLAN_ID}/sharing`)
    ).json();
    expect(state).toMatchObject({ hasShareCode: true });
    expect(JSON.stringify(state)).not.toContain(code);
  });

  test("clearing a code", async () => {
    const app = shared({
      shareCodeHash: await hashShareCode("oldcode12345678"),
    });

    const response = await app.fetch(`/api/plans/${PLAN_ID}/share-code`, {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(
      await (await app.fetch(`/api/plans/${PLAN_ID}/sharing`)).json(),
    ).toMatchObject({ hasShareCode: false });
  });

  test("granting an account, and reporting one nothing answers to", async () => {
    const app = shared();

    const response = await app.fetch(`/api/plans/${PLAN_ID}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accounts: "brisk-heron, nobody" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json<unknown>()).toEqual({
      granted: ["brisk-heron"],
      unknown: ["nobody"],
      failed: [],
    });
  });

  test("revoking a grant", async () => {
    const app = shared({ grants: [GRANTEE] });

    const response = await app.fetch(
      `/api/plans/${PLAN_ID}/grants/brisk-heron`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(
      await (await app.fetch(`/api/plans/${PLAN_ID}/sharing`)).json(),
    ).toMatchObject({ grants: [] });
  });

  test("a handle needing escaping survives the round trip", async () => {
    const app = buildApp({
      sessionUser: OWNER,
      plans: memoryPlans([storedPlan({ grants: [GRANTEE] })], {
        "odd handle": GRANTEE,
      }),
    });

    const response = await app.fetch(
      `/api/plans/${PLAN_ID}/grants/${encodeURIComponent("odd handle")}`,
      { method: "DELETE" },
    );

    // 204 alone only says the route matched. The point of the escaping is
    // that the handle it decoded is the one whose grant went.
    expect(response.status).toBe(204);
    expect(
      await (await app.fetch(`/api/plans/${PLAN_ID}/sharing`)).json(),
    ).toMatchObject({ grants: [] });
  });

  test("a stranger cannot read or change sharing", async () => {
    /*
     * Seeded with a share code and an existing grant, and with both handles
     * resolvable. Against a bare plan half the loop below would be a no-op
     * whatever the route did - clearing an absent code, revoking an absent
     * grant, naming an account nothing answers to - so the state assertion
     * afterwards would hold even if every refusal were removed.
     */
    const hash = await hashShareCode("sHaReCoDe1234567");
    const plans = memoryPlans(
      [storedPlan({ shareCodeHash: hash, grants: [GRANTEE] })],
      { "brisk-heron": GRANTEE, stranger: STRANGER },
    );
    const app = buildApp({ sessionUser: STRANGER, plans });

    const asJson = (body: unknown) => ({
      method: "PUT" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    for (const [path, init] of [
      [`/api/plans/${PLAN_ID}/sharing`, undefined],
      // The two that change it, which are the ones worth refusing: going public
      // and granting an account are how a stranger would help themselves.
      [`/api/plans/${PLAN_ID}/sharing`, asJson({ visibility: "public" })],
      [
        `/api/plans/${PLAN_ID}/grants`,
        { ...asJson({ accounts: "stranger" }), method: "POST" as const },
      ],
      [`/api/plans/${PLAN_ID}/share-code`, { method: "POST" }],
      [`/api/plans/${PLAN_ID}/share-code`, { method: "DELETE" }],
      [`/api/plans/${PLAN_ID}/grants/brisk-heron`, { method: "DELETE" }],
    ] as const) {
      const response = await app.fetch(path, init);
      expect(response.status).toBe(404);
    }

    /*
     * Read off the row rather than the owner's sharing view: that view reports
     * `hasShareCode` as a boolean, so a rotation replacing one hash with
     * another would leave it `true` and go unseen. The hash itself is the only
     * thing that shows the POST above changed nothing.
     */
    const row = plans.rows.get(PLAN_ID);
    expect(row).toMatchObject({
      visibility: "private",
      shareCodeHash: hash,
      grants: [GRANTEE],
    });
  });
});

describe("redeeming a code", () => {
  const CODE = "sHaReCoDe1234567";

  const gated = async () =>
    buildApp({
      plans: memoryPlans([
        storedPlan({ shareCodeHash: await hashShareCode(CODE) }),
      ]),
      storage: memoryStorage({ [PLAN_ID]: "<p>secret</p>" }),
    });

  /**
   * The method, headers and body every unlock request here carries.
   *
   * `identified` drops the forwarded-address header. It is a parameter rather
   * than a hand-written literal at that one call site so the missing header is
   * the only difference between the cases, which is what they are contrasting.
   */
  const unlockInit = (code: string, identified = true): RequestInit => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(identified ? { [CLIENT_IP_HEADER]: CLIENT_IP } : {}),
    },
    body: JSON.stringify({ code }),
  });

  test("a correct code sets the unlock cookie, with no credential at all", async () => {
    const app = await gated();

    const response = await app.fetch(
      `/api/plans/${PLAN_ID}/unlock`,
      unlockInit(CODE),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain(
      shareCookieName(PLAN_ID),
    );
    // Nothing about the account was consulted: this is the point of the route.
    expect(app.auth.sessions).toBe(0);
    expect(app.auth.keys).toBe(0);
  });

  test("a wrong code is refused", async () => {
    const app = await gated();

    const response = await app.fetch(
      `/api/plans/${PLAN_ID}/unlock`,
      unlockInit("wrongcode1234567"),
    );

    // 401, not 403: no credential was accepted, and the reader may still
    // present a correct one.
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("the throttle answers before the code is even compared", async () => {
    const app = buildApp({
      plans: memoryPlans([
        storedPlan({ shareCodeHash: await hashShareCode(CODE) }),
      ]),
      unlockRateLimits: closedRateLimits,
    });

    const response = await app.fetch(
      `/api/plans/${PLAN_ID}/unlock`,
      unlockInit(CODE),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  /**
   * A counter that actually spends, rather than a fake reporting a verdict.
   *
   * The two tests below are about the difference between spending and asking,
   * so a limiter that always answered the same thing could not show it.
   */
  const countingLimits = (max: number) => {
    const counts = new Map<string, number>();
    return {
      consume: async (key: string) => {
        const spent = (counts.get(key) ?? 0) + 1;
        counts.set(key, spent);
        return { allowed: spent <= max, retryAfter: 30 };
      },
      peek: async (key: string) => ({
        allowed: (counts.get(key) ?? 0) < max,
        retryAfter: 30,
      }),
    };
  };

  test("a correct code costs nothing, however many readers open the link", async () => {
    const app = buildApp({
      plans: memoryPlans([
        storedPlan({ shareCodeHash: await hashShareCode(CODE) }),
      ]),
      unlockRateLimits: countingLimits(3),
    });

    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await app.fetch(
        `/api/plans/${PLAN_ID}/unlock`,
        unlockInit(CODE),
      );
      statuses.push(response.status);
    }

    // Eight openings against a budget of three. A share link is opened by
    // everyone it was sent to, and charging those meant a link pasted into one
    // channel refused the colleagues behind the same egress address from the
    // fourth onwards - locked out of a plan they had been given.
    expect(statuses).toEqual([204, 204, 204, 204, 204, 204, 204, 204]);
  });

  test("wrong codes still run out, which is what the budget is for", async () => {
    const app = buildApp({
      plans: memoryPlans([
        storedPlan({ shareCodeHash: await hashShareCode(CODE) }),
      ]),
      unlockRateLimits: countingLimits(3),
    });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await app.fetch(
        `/api/plans/${PLAN_ID}/unlock`,
        unlockInit("wrongcode1234567"),
      );
      statuses.push(response.status);
    }

    // Three guesses, then the gate closes. Guessing is the thing rationed, and
    // a correct code being free must not make a wrong one free too.
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });

  test("a caller the proxy did not identify is refused, not counted", async () => {
    let consumed = 0;
    let peeked = 0;
    const app = buildApp({
      plans: memoryPlans([
        storedPlan({ shareCodeHash: await hashShareCode(CODE) }),
      ]),
      unlockRateLimits: {
        consume: async () => {
          consumed += 1;
          return { allowed: true, retryAfter: 0 };
        },
        peek: async () => {
          peeked += 1;
          return { allowed: true, retryAfter: 0 };
        },
      },
    });

    const response = await app.fetch(
      `/api/plans/${PLAN_ID}/unlock`,
      unlockInit(CODE, false),
    );

    // The alternative is one shared bucket for every anonymous caller, which
    // is exactly the lockout the per-address keying exists to prevent.
    expect(response.status).toBe(429);
    // A flat one second from the handler's own unidentified-caller branch, not
    // the limiter's window: neither half of the limiter having been called is
    // what says it was never reached to be asked.
    expect(response.headers.get("retry-after")).toBe("1");
    expect(consumed).toBe(0);
    expect(peeked).toBe(0);
  });

  test("the bucket is keyed on the address, never on the plan", async () => {
    const keys: string[] = [];
    const plans = memoryPlans([
      storedPlan({
        id: "aaaaaaaaaaaaaaaa",
        shareCodeHash: await hashShareCode(CODE),
      }),
      storedPlan({
        id: "bbbbbbbbbbbbbbbb",
        shareCodeHash: await hashShareCode(CODE),
      }),
    ]);
    const app = buildApp({
      plans,
      unlockRateLimits: {
        consume: async (key) => {
          keys.push(key);
          return { allowed: true, retryAfter: 0 };
        },
        // Recorded from the gate rather than the spend: these three redemptions
        // all succeed, and a correct code is exactly what no longer spends.
        peek: async (key) => {
          keys.push(key);
          return { allowed: true, retryAfter: 0 };
        },
      },
    });

    for (const id of ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]) {
      await app.fetch(`/api/plans/${id}/unlock`, unlockInit(CODE));
    }
    // A third caller, same plan as the first, different address.
    await app.fetch("/api/plans/aaaaaaaaaaaaaaaa/unlock", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLIENT_IP_HEADER]: "203.0.113.9",
      },
      body: JSON.stringify({ code: CODE }),
    });

    // Without the count this passes on an empty list: two undefined reads are
    // equal, and the handler producing no keys at all is the failure mode.
    expect(keys).toHaveLength(3);
    // Per-plan would let anyone holding a share link spend the allowance and
    // lock the real readers out of a plan they do not own.
    expect(keys[0]).toBe(keys[1]);
    /*
     * And per-address really is per-address. Equality alone is satisfiable by
     * a handler that returns one constant for everybody, which would share a
     * single allowance across the whole internet.
     */
    expect(keys[2]).not.toBe(keys[0]);
    // The address itself is not what is stored, in either bucket.
    expect(keys[0]).not.toContain(CLIENT_IP);
    expect(keys[2]).not.toContain("203.0.113.9");
  });
});

/**
 * The page a share link points at.
 *
 * A share code rides in the fragment so it reaches no access log, no proxy and
 * no `Referer`. It cannot ride on `/p/{id}`, because that path answers a reader
 * who already has access with the uploaded document - untrusted HTML, which can
 * read its own `location.hash`. `/s/{id}` is the app's own page: it spends the
 * code and then sends the reader to the plan.
 *
 * The fragment never reaches this route at all, which is the point. What these
 * assert is that the route always answers with the app's own page - whatever the
 * reader's authorisation - so there is no state in which a fragment could land
 * on plan HTML instead.
 */
describe("the share-link relay", () => {
  const CODE = "sHaReCoDe1234567";
  const DOCUMENT = "<p>the plan itself</p>";

  const shared = async (over: Record<string, unknown> = {}) =>
    buildApp({
      plans: memoryPlans([
        storedPlan({ shareCodeHash: await hashShareCode(CODE) }),
      ]),
      storage: memoryStorage({ [PLAN_ID]: DOCUMENT }),
      ...over,
    });

  // Built from the id the client actually looks the element up by, so a rename
  // breaks this rather than leaving it matching nothing and parsing "{}".
  const propsOf = (markup: string): Record<string, unknown> => {
    const pattern = new RegExp(`id="${PAGE_PROPS_ID}">([^<]*)<`);
    const json = pattern.exec(markup)?.[1] ?? "{}";
    return JSON.parse(json) as Record<string, unknown>;
  };

  test("renders the app's own page, not the plan", async () => {
    const app = await shared();

    const response = await app.fetch(`/s/${PLAN_ID}`);
    const markup = await response.text();

    expect(response.status).toBe(200);
    expect(markup).toContain("This plan is private.");
    // The document is what must not be here: it is the thing that could read a
    // fragment this page is holding.
    expect(markup).not.toContain(DOCUMENT);
    expect(propsOf(markup)).toMatchObject({
      name: "gate",
      planId: PLAN_ID,
      relay: true,
      hasCode: true,
    });
  });

  test("answers an authorised reader the same way", async () => {
    // The case the fragment makes dangerous anywhere else. `/p/{id}` would hand
    // this reader the document, so if the share link pointed there the code in
    // their address bar would be sitting on untrusted HTML. This route does not
    // consult authorisation at all, so there is no such branch to get wrong.
    const app = await shared({ sessionUser: OWNER });

    const response = await app.fetch(`/s/${PLAN_ID}`);
    const markup = await response.text();

    expect(response.status).toBe(200);
    expect(markup).not.toContain(DOCUMENT);
    expect(propsOf(markup)).toMatchObject({ relay: true });
  });

  test("never puts the stored digest on the page, only whether there is one", async () => {
    const hash = await hashShareCode(CODE);
    const app = await shared();

    const markup = await (await app.fetch(`/s/${PLAN_ID}`)).text();

    // The digest is what would let a holder forge this plan's unlock cookie.
    expect(markup).not.toContain(hash);
    expect(propsOf(markup)).toMatchObject({ hasCode: true });
  });

  test("says there is no code when the plan has none", async () => {
    const app = buildApp({
      plans: memoryPlans([storedPlan({ shareCodeHash: null })]),
      storage: memoryStorage({ [PLAN_ID]: DOCUMENT }),
    });

    const markup = await (await app.fetch(`/s/${PLAN_ID}`)).text();

    expect(propsOf(markup)).toMatchObject({ hasCode: false, relay: true });
  });

  test("is not cached: it is one step in redeeming a credential", async () => {
    const app = await shared();

    const response = await app.fetch(`/s/${PLAN_ID}`);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("an unknown id renders the site's own 404, as the plan path does", async () => {
    const app = buildApp({ plans: memoryPlans([]) });

    const response = await app.fetch("/s/zzzzzzzzzzzzzzzz");

    // The same disclosure as `/p/{unknown}`: this route reveals that a plan
    // exists and nothing else, which that path already does.
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Nothing lives at this URL");
  });
});

describe("auth and docs", () => {
  test("everything under the auth prefix is handed to Better Auth", async () => {
    const seen: string[] = [];
    const app = buildApp({
      authHandler: async (request) => {
        seen.push(new URL(request.url).pathname);
        return new Response(null, { status: 204 });
      },
    });

    for (const path of ["/api/auth/session", "/api/auth/passkey/verify"]) {
      expect((await app.fetch(path, { method: "POST" })).status).toBe(204);
    }

    expect(seen).toEqual(["/api/auth/session", "/api/auth/passkey/verify"]);
  });

  test("the spec is generated from the running configuration", async () => {
    const app = buildApp();

    const response = await app.fetch("/api/openapi.json");

    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      openapi: string;
      servers: Array<{ url: string }>;
    };
    expect(spec.openapi).toStartWith("3.");
    expect(spec.servers[0]?.url).toBe(PUBLIC_BASE_URL);
  });

  test("the reference page renders and needs no services", async () => {
    let resolved = 0;
    const app = buildApp({
      onServices: () => {
        resolved += 1;
      },
    });

    const response = await app.fetch("/api/docs");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(resolved).toBe(0);
  });
});

describe("routes that do not exist", () => {
  test("an unknown API path answers like the API", async () => {
    const response = await buildApp().fetch("/api/nope");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("json");
    expect(await response.json<unknown>()).toMatchObject({
      error: "not found",
    });
  });

  test("the bare /api prefix does too", async () => {
    const response = await buildApp().fetch("/api");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("json");
  });

  test("an unknown page gets the site's own 404, not 2 KB of landing page", async () => {
    const response = await buildApp().fetch("/nope");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Nothing lives at this URL.");
  });

  test("a path that merely starts with the word api is a page, not an API miss", async () => {
    const response = await buildApp().fetch("/apidocs");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});

describe("the security headers the middleware pins", () => {
  /*
   * Spelled out rather than compared against `APP_CSP`. Asserting the header
   * equals the constant that produces it only proves the middleware read its
   * own source: dropping `object-src` would still pass. These are the
   * directives the policy exists for, so they are written out here and a
   * weakened source has to fail one of them.
   */
  const REQUIRED_DIRECTIVES = [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  test("every app response carries them, including a 404", async () => {
    const app = buildApp();

    for (const path of ["/", "/api/plans", "/nope"]) {
      const response = await app.fetch(path);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      // Split into whole directives rather than matched as substrings: a
      // policy reading `not-base-uri 'none'` contains the text and forbids
      // nothing.
      const directives = (response.headers.get("content-security-policy") ?? "")
        .split(";")
        .map((directive) => directive.trim());
      for (const directive of REQUIRED_DIRECTIVES) {
        expect(directives).toContain(directive);
      }
    }
  });

  test("the share-link relay gets the app policy, because it has to hydrate", async () => {
    /*
     * `/s/{id}` is one character away from the plan prefix and does the opposite
     * job: it is the app's own page, and it redeems a share code from the URL
     * fragment in the browser. Under the plan sandbox it could run no script at
     * all, so every share link would quietly stop working while still rendering
     * something that looks right.
     *
     * Asserted on the headers rather than the body, because that is the failure
     * a body test cannot see - widening `PLAN_PATH_PREFIX` to `/` or `/s` would
     * leave this markup unchanged.
     */
    const app = buildApp({
      plans: memoryPlans([storedPlan({ shareCodeHash: null })]),
    });

    const response = await app.fetch(`/s/${PLAN_ID}`);
    const directives = (response.headers.get("content-security-policy") ?? "")
      .split(";")
      .map((directive) => directive.trim());

    for (const directive of REQUIRED_DIRECTIVES) {
      expect(directives).toContain(directive);
    }
    // The sandbox is what the plan path adds and this path must not have: it is
    // an opaque origin with no scripting.
    expect(
      directives.some((directive) => directive.startsWith("sandbox")),
    ).toBe(false);
  });
});

describe("the health probe", () => {
  test("reports every backend on node", async () => {
    const response = await buildApp({ runtime: "node" }).fetch("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json<unknown>()).toMatchObject({
      status: "ok",
      checks: { storage: "ok", db: "ok", kv: "ok" },
    });
  });

  test("refuses on Workers before any binding is touched", async () => {
    let resolved = 0;
    const app = buildApp({
      runtime: "cloudflare",
      onServices: () => {
        resolved += 1;
      },
    });

    const response = await app.fetch("/healthz");

    // An unauthenticated call that fanned out into three billable backend
    // operations is an amplifier anyone holding the URL can point at the bill.
    expect(response.status).toBe(404);
    expect(resolved).toBe(0);
  });
});
