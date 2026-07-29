import { describe, expect, test } from "bun:test";
import { hashShareCode, shareCookieName } from "../src/http/share-auth.ts";
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

  test("an exhausted upload budget is refused before the document is read", async () => {
    const app = buildApp({
      sessionUser: OWNER,
      uploadRateLimits: closedRateLimits,
    });

    const response = await app.fetch("/api/plans", upload(OK_HTML));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(app.storage.objects.size).toBe(0);
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
    expect(body.plans.length).toBe(500);
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
    expect(code).toMatch(/^[0-9a-z]{16}$/i);

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

    expect(response.status).toBe(204);
  });

  test("a stranger cannot read or change sharing", async () => {
    const app = buildApp({
      sessionUser: STRANGER,
      plans: memoryPlans([storedPlan()]),
    });

    for (const [path, init] of [
      [`/api/plans/${PLAN_ID}/sharing`, undefined],
      [`/api/plans/${PLAN_ID}/share-code`, { method: "POST" }],
      [`/api/plans/${PLAN_ID}/share-code`, { method: "DELETE" }],
      [`/api/plans/${PLAN_ID}/grants/brisk-heron`, { method: "DELETE" }],
    ] as const) {
      const response = await app.fetch(path, init);
      expect(response.status).toBe(404);
    }
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

  test("a correct code sets the unlock cookie, with no credential at all", async () => {
    const app = await gated();

    const response = await app.fetch(`/api/plans/${PLAN_ID}/unlock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLIENT_IP_HEADER]: CLIENT_IP,
      },
      body: JSON.stringify({ code: CODE }),
    });

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

    const response = await app.fetch(`/api/plans/${PLAN_ID}/unlock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLIENT_IP_HEADER]: CLIENT_IP,
      },
      body: JSON.stringify({ code: "wrongcode1234567" }),
    });

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

    const response = await app.fetch(`/api/plans/${PLAN_ID}/unlock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLIENT_IP_HEADER]: CLIENT_IP,
      },
      body: JSON.stringify({ code: CODE }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  test("a caller the proxy did not identify is refused, not counted", async () => {
    let consumed = 0;
    const app = buildApp({
      plans: memoryPlans([
        storedPlan({ shareCodeHash: await hashShareCode(CODE) }),
      ]),
      unlockRateLimits: {
        consume: async () => {
          consumed += 1;
          return { allowed: true, retryAfter: 0 };
        },
      },
    });

    const response = await app.fetch(`/api/plans/${PLAN_ID}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: CODE }),
    });

    // The alternative is one shared bucket for every anonymous caller, which
    // is exactly the lockout the per-address keying exists to prevent.
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(consumed).toBe(0);
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
      },
    });

    for (const id of ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]) {
      await app.fetch(`/api/plans/${id}/unlock`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CLIENT_IP_HEADER]: CLIENT_IP,
        },
        body: JSON.stringify({ code: CODE }),
      });
    }

    // Without the count this passes on an empty list: two undefined reads are
    // equal, and the handler producing no keys at all is the failure mode.
    expect(keys).toHaveLength(2);
    // Per-plan would let anyone holding a share link spend the allowance and
    // lock the real readers out of a plan they do not own.
    expect(keys[0]).toBe(keys[1]);
    // And the address itself is not what is stored.
    expect(keys[0]).not.toContain(CLIENT_IP);
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
  test("every app response carries them, including a 404", async () => {
    const app = buildApp();

    for (const path of ["/", "/api/plans", "/nope"]) {
      const response = await app.fetch(path);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).not.toBeNull();
    }
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
