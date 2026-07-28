import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { validate } from "@scalar/openapi-parser";
import { DOCS_PAGE, SCALAR_SCRIPT_PATH } from "../../src/api/docs-page.ts";
import { ErrorBody, PlanCreated, PlanReplaced } from "../../src/api/schemas.ts";
import { PLAN_CSP } from "../../src/http/security-headers.ts";
import {
  type FetchInit,
  type FetchResponse,
  type Harness,
  html,
  MAX_PLANS_PER_USER,
  PUBLIC_BASE_URL,
  SHARE_CODE_LENGTH,
  startWorker,
  UPLOAD_RATE_MAX,
  upload,
} from "./harness.ts";

let app: Harness;

/**
 * `startWorker()` runs a full build before it boots Miniflare, which is
 * nowhere near the 5 second default for a hook. Tests run one process per file
 * (see tests/drivers/plan-storage.r2.test.ts for why), so on a four-core
 * runner this build competes with twenty-odd other files and takes far longer
 * than it does on an idle machine. The bound is here to catch a build that has
 * genuinely hung, not to police how long a cold one takes.
 */
const BOOT_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  app = await startWorker();
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
}, BOOT_TIMEOUT_MS);

interface Created {
  id: string;
  url: string;
  label: string | null;
  /** Present only for `?visibility=code`; the plaintext, shown once. */
  code?: string;
  /** Both present only for `?grants=`. */
  granted?: string[];
  unknown?: string[];
}

/** `Response.json()` erases the body; assertions need something to compare. */
async function jsonBody(
  response: FetchResponse,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Plans are private unless asked otherwise, so most tests here that only need
 * a servable document ask for `public` - the gate itself is exercised by its
 * own describe block below.
 */
async function createPlan(
  key: string,
  body: string,
  over: {
    label?: string;
    visibility?: "public" | "private" | "code";
    grants?: string;
  } = {},
): Promise<Created> {
  const query = new URLSearchParams();
  if (over.label !== undefined) query.set("label", over.label);
  if (over.grants !== undefined) query.set("grants", over.grants);
  query.set("visibility", over.visibility ?? "public");
  const response = await app.fetch(
    `/api/plans?${query.toString()}`,
    upload(key, body),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as Created;
}

async function storedSize(id: string): Promise<number | null> {
  const row = await app.db
    .prepare("select size from plan where id = ?")
    .bind(id)
    .first<{ size: number }>();
  return row?.size ?? null;
}

async function storedLabel(id: string): Promise<string | null> {
  const row = await app.db
    .prepare("select label from plan where id = ?")
    .bind(id)
    .first<{ label: string | null }>();
  return row?.label ?? null;
}

describe("plan lifecycle over HTTP", () => {
  test("refuses an upload with no credential", async () => {
    const response = await app.fetch("/api/plans", {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: html("anonymous"),
    });
    expect(response.status).toBe(401);
  });

  test("uploads a plan and serves it sandboxed at its public URL", async () => {
    const key = await app.account();
    const body = html("published");
    const created = await createPlan(key, body, { label: "Q3 rollout" });

    expect(created.url).toBe(`${PUBLIC_BASE_URL}/p/${created.id}`);
    expect(created.label).toBe("Q3 rollout");
    expect(await storedSize(created.id)).toBe(body.length);

    const served = await app.fetch(`/p/${created.id}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(body);
    expect(served.headers.get("content-security-policy")).toBe(PLAN_CSP);
  });

  /**
   * The 304 is the dangerous branch. It legitimately carries almost no
   * headers, and the entry wrapper fills in whatever a response leaves
   * absent - so a plan that omitted its policy here would be revalidated
   * into the cache under the APP policy, which has no `sandbox`. A cache
   * updating a stored response from a 304 (RFC 9111 4.3.4) would then hold
   * the plan under a policy that lets it script the real origin.
   */
  test("serves the same sandbox policy on a 304 as on the 200", async () => {
    const key = await app.account();
    const created = await createPlan(key, html("revalidated"));

    const fresh = await app.fetch(`/p/${created.id}`);
    const etag = fresh.headers.get("etag");
    expect(etag).not.toBeNull();

    const revalidated = await app.fetch(`/p/${created.id}`, {
      headers: { "if-none-match": etag ?? "" },
    });

    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("content-security-policy")).toBe(PLAN_CSP);
    expect(fresh.headers.get("content-security-policy")).toBe(PLAN_CSP);
  });

  test("replaces the document behind an id, keeping the URL and the label", async () => {
    const key = await app.account();
    const created = await createPlan(key, html("before"), { label: "keep me" });

    const revised = html("after, and rather longer than before");
    const response = await app.fetch(
      `/api/plans/${created.id}`,
      upload(key, revised),
    );

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({
      id: created.id,
      url: created.url,
    });
    expect(await (await app.fetch(`/p/${created.id}`)).text()).toBe(revised);
    expect(await storedSize(created.id)).toBe(revised.length);
    expect(await storedLabel(created.id)).toBe("keep me");
  });

  test("refuses a replacement from another account and leaves the plan alone", async () => {
    const owner = await app.account();
    const stranger = await app.account();
    const body = html("mine");
    const created = await createPlan(owner, body);

    const response = await app.fetch(
      `/api/plans/${created.id}`,
      upload(stranger, html("hijacked")),
    );

    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toEqual({ error: "not found" });
    expect(await (await app.fetch(`/p/${created.id}`)).text()).toBe(body);
    expect(await storedSize(created.id)).toBe(body.length);
  });

  test("refuses a replacement for an id that does not exist", async () => {
    const key = await app.account();
    const response = await app.fetch(
      "/api/plans/nosuchplanid",
      upload(key, html("nobody")),
    );
    // Route existence is held by tests/openapi.test.ts, which compares Hono's
    // routing table against the published document - an unrouted PUT is a 404
    // with this same body now, so it could not fail here.
    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toEqual({ error: "not found" });
  });

  test("refuses a replacement that is not standalone, keeping the old document", async () => {
    const key = await app.account();
    const body = html("intact");
    const created = await createPlan(key, body);

    const response = await app.fetch(
      `/api/plans/${created.id}`,
      upload(
        key,
        '<!doctype html><html><body><script src="https://cdn.example.com/x.js"></script></body></html>',
      ),
    );

    expect(response.status).toBe(422);
    expect(await (await app.fetch(`/p/${created.id}`)).text()).toBe(body);
    expect(await storedSize(created.id)).toBe(body.length);
  });

  test("counts replacements against the same allowance as uploads", async () => {
    const key = await app.account();
    const created = await createPlan(key, html("first"));

    // One upload is already spent, so the remaining allowance runs out partway
    // through this loop; the point is that a replacement is what spends it.
    let refused: FetchResponse | null = null;
    for (let attempt = 1; attempt < UPLOAD_RATE_MAX + 1; attempt += 1) {
      const response = await app.fetch(
        `/api/plans/${created.id}`,
        upload(key, html(`revision ${attempt}`)),
      );
      if (response.status === 429) {
        refused = response;
        break;
      }
      expect(response.status).toBe(200);
    }

    expect(refused).not.toBeNull();
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("deletes only for the owner, and takes the URL out of service", async () => {
    const owner = await app.account();
    const stranger = await app.account();
    const created = await createPlan(owner, html("temporary"));

    const refused = await app.fetch(`/api/plans/${created.id}`, {
      method: "DELETE",
      headers: { "x-api-key": stranger },
    });
    expect(refused.status).toBe(404);
    expect((await app.fetch(`/p/${created.id}`)).status).toBe(200);

    const deleted = await app.fetch(`/api/plans/${created.id}`, {
      method: "DELETE",
      headers: { "x-api-key": owner },
    });
    expect(deleted.status).toBe(204);
    expect((await app.fetch(`/p/${created.id}`)).status).toBe(404);
    expect(await storedSize(created.id)).toBeNull();
  });

  /**
   * A bucket holding more than plans is the ordinary self-hosted layout, so
   * `/p/{planId}` must resolve only within the plan namespace. Both halves of
   * the mapping are exercised: the id check refuses a segment the generator
   * could not have issued, and the `plans/` prefix bounds what a key can name.
   */
  test("never serves an object outside the plan namespace", async () => {
    await app.bucket.put("config.json", "NOT-A-PLAN");
    await app.bucket.put("backups/db.sql", "NOT-A-PLAN");

    for (const probe of [
      "config.json",
      "backups%2Fdb.sql",
      "..%2F..%2Fconfig.json",
      "%2Fconfig.json",
    ]) {
      const response = await app.fetch(`/p/${probe}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("NOT-A-PLAN");
    }
  });

  test("stores plan objects under the plans/ prefix", async () => {
    const key = await app.account();
    const created = await createPlan(key, html("namespaced"));

    expect(await app.bucket.head(`plans/${created.id}`)).not.toBeNull();
    // Nothing at the bare id: the prefix is the only place a plan lives.
    expect(await app.bucket.head(created.id)).toBeNull();
  });

  test("refuses an upload once the account is at its plan ceiling", async () => {
    const key = await app.account();
    const mine: Created[] = [];
    for (let i = 0; i < MAX_PLANS_PER_USER; i += 1) {
      mine.push(await createPlan(key, html(`quota ${i}`)));
    }

    const refused = await app.fetch("/api/plans", upload(key, html("over")));
    expect(refused.status).toBe(409);
    expect((await jsonBody(refused))["error"]).toContain("plan limit reached");

    // Deleting one frees exactly one slot, so the ceiling is a ceiling and
    // not a lifetime total.
    await app.fetch(`/api/plans/${mine[0]?.id}`, {
      method: "DELETE",
      headers: { "x-api-key": key },
    });
    expect(
      (await app.fetch("/api/plans", upload(key, html("again")))).status,
    ).toBe(201);
  });

  /**
   * The ceiling has to hold under concurrency, which is why it lives in the
   * claiming statement rather than in a count the handler reads first: two
   * uploads that both read `MAX_PLANS_PER_USER - 1` would both have passed.
   */
  test("holds the ceiling when uploads race", async () => {
    const key = await app.account();
    const attempts = await Promise.all(
      Array.from({ length: MAX_PLANS_PER_USER + 2 }, (_, i) =>
        app.fetch("/api/plans", upload(key, html(`race ${i}`))),
      ),
    );

    const created = attempts.filter((r) => r.status === 201).length;
    const refused = attempts.filter((r) => r.status === 409).length;
    expect(created).toBe(MAX_PLANS_PER_USER);
    expect(refused).toBe(2);
  });
});

/**
 * Server-rendered pages must describe the deployment, not the request. The
 * origin used to come from `getRequestUrl()`, so a proxy forwarding an
 * arbitrary `Host` produced Open Graph tags pointing at whatever hostname the
 * caller supplied - a link preview on the attacker's domain, attributed to
 * this site.
 */
describe("server-rendered document head", () => {
  const ATTACKER = "evil.example";

  test("builds absolute URLs from the configured origin", async () => {
    const response = await app.fetch("/", { headers: { host: ATTACKER } });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(ATTACKER);
    expect(body).toContain(`content="${PUBLIC_BASE_URL}/"`);
    expect(body).toContain(`content="${PUBLIC_BASE_URL}/og-v2.png"`);
  });

  test("ignores a forwarded host as well as the host itself", async () => {
    const body = await (
      await app.fetch("/", {
        headers: { "x-forwarded-host": ATTACKER, "x-forwarded-proto": "http" },
      })
    ).text();

    expect(body).not.toContain(ATTACKER);
    expect(body).toContain(`content="${PUBLIC_BASE_URL}/og-v2.png"`);
  });

  test("still reflects the path so per-page tags stay correct", async () => {
    const body = await (
      await app.fetch("/dashboard", { headers: { host: ATTACKER } })
    ).text();

    expect(body).toContain(`content="${PUBLIC_BASE_URL}/dashboard"`);
    expect(body).not.toContain(ATTACKER);
  });
});

/**
 * The document is only worth publishing if it describes what the Worker
 * actually sends. These parse real responses with the very schemas
 * src/api/openapi.ts is built from, so a handler that drifts fails here even
 * where `satisfies` cannot see it - a route returning the wrong shape at
 * runtime, or a field the type says is a string and the driver returns as a
 * number.
 */
describe("the published document describes the real responses", () => {
  test("serves a spec that validates as OpenAPI 3.1", async () => {
    const response = await app.fetch("/api/openapi.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith(
      "application/json",
    );

    const spec = (await response.json()) as {
      servers: Array<{ url: string }>;
    };
    const result = await validate(spec);
    expect(result.errors ?? []).toEqual([]);
    expect(result.version).toBe("3.1");
    expect(spec.servers[0]?.url).toBe(PUBLIC_BASE_URL);
  });

  test("an upload matches PlanCreated", async () => {
    const key = await app.account();
    const response = await app.fetch(
      "/api/plans?label=documented",
      upload(key, html("documented")),
    );

    expect(response.status).toBe(201);
    const body = PlanCreated.parse(await response.json());
    expect(response.headers.get("location")).toBe(body.url);
  });

  test("a replacement matches PlanReplaced", async () => {
    const key = await app.account();
    const created = await createPlan(key, html("first"));
    const response = await app.fetch(
      `/api/plans/${created.id}`,
      upload(key, html("second")),
    );

    expect(response.status).toBe(200);
    expect(PlanReplaced.parse(await response.json()).id).toBe(created.id);
  });

  test("a listing matches PlanList", async () => {
    // Session-only, so an API key gets the documented 401 rather than a page.
    const response = await app.fetch("/api/plans", {
      headers: { "x-api-key": await app.account() },
    });

    expect(response.status).toBe(401);
    expect(ErrorBody.parse(await response.json()).error).toBe(
      "authentication required",
    );
  });

  test("a refusal matches Error", async () => {
    const key = await app.account();
    const response = await app.fetch("/api/plans", {
      method: "PUT",
      headers: { "x-api-key": key, "content-type": "text/plain" },
      body: "not html",
    });

    expect(response.status).toBe(415);
    expect(ErrorBody.parse(await response.json())).toEqual({
      error: "content-type must be text/html",
    });
  });
});

describe("the reference UI", () => {
  test("serves a page that loads the vendored bundle", async () => {
    const response = await app.fetch("/api/docs");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    expect(await response.text()).toBe(DOCS_PAGE);
  });

  /**
   * Fetched from the build output rather than through the Worker: static
   * assets are served by Cloudflare in front of the script, and the Miniflare
   * harness does not emulate that layer - `/og-v2.png` 404s here too. What
   * this can still prove is that the URL the page asks for names a file the
   * deployed bundle actually contains.
   */
  test("the bundle the page asks for is in the client build", async () => {
    const built = Bun.file(
      `${import.meta.dir}/../../dist/client${SCALAR_SCRIPT_PATH}`,
    );

    expect(await built.exists()).toBe(true);
    expect(await built.text()).toContain("window.Scalar={");
  });
});

/**
 * The `bkp_share_*` cookie from a response, as a browser would send it back.
 *
 * `getSetCookie()` rather than `get("set-cookie")`: several cookies can share
 * one response, and `get` folds them into a single comma-joined string that
 * splitting on `;` would mangle.
 */
function shareCookie(response: FetchResponse): string {
  const values = response.headers.getSetCookie();
  const share = values.find((value) => value.startsWith("bkp_share_"));
  expect(share).toBeDefined();
  return (share ?? "").split(";")[0] ?? "";
}

describe("gated sharing", () => {
  /**
   * Everything below leans on this cookie, so it is proved first. Inserting a
   * `session` row and sending the raw token does not work: Better Auth reads
   * the cookie signed, so an unsigned value is silently unauthenticated and
   * every session-only assertion would pass for the wrong reason.
   */
  test("the harness mints a session the Worker actually accepts", async () => {
    const { cookie } = await app.accountWithSession();

    const signedIn = await app.fetch("/api/plans", { headers: { cookie } });
    expect(signedIn.status).toBe(200);

    expect((await app.fetch("/api/plans")).status).toBe(401);
  });

  /**
   * A grant is displayed as `user.name` but resolved through the synthetic
   * `@passkey.invalid` address derived from that name at registration. If a
   * grantee could rename itself, the owner would be shown a handle whose
   * revoke computes an address belonging to nobody - the grant would still be
   * live and no longer removable through the API or the dashboard.
   *
   * Better Auth ships `/update-user`, so this is a route that has to stay
   * switched off rather than one that was never there.
   */
  test("a session cannot rename its account out of a grant", async () => {
    const owner = await app.accountWithSession();
    const guest = await app.accountWithSession();
    const created = await createPlan(owner.key, html("immutable"), {
      visibility: "private",
    });
    const session = { cookie: owner.cookie };

    const granted = await app.fetch(`/api/plans/${created.id}/grants`, {
      method: "POST",
      headers: { ...session, "content-type": "application/json" },
      body: JSON.stringify({ accounts: guest.handle }),
    });
    expect(granted.status).toBe(200);

    const renamed = await app.fetch("/api/auth/update-user", {
      method: "POST",
      headers: { cookie: guest.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "sneakyrename" }),
    });
    expect(renamed.status).toBe(404);

    // The owner still sees the handle they granted, and revoking it works.
    const sharing = await app.fetch(`/api/plans/${created.id}/sharing`, {
      headers: session,
    });
    expect((await jsonBody(sharing))["grants"]).toEqual([guest.handle]);

    const revoked = await app.fetch(
      `/api/plans/${created.id}/grants/${guest.handle}`,
      { method: "DELETE", headers: session },
    );
    expect(revoked.status).toBe(204);
    expect(
      (
        await app.fetch(`/p/${created.id}`, {
          headers: { cookie: guest.cookie },
        })
      ).status,
    ).toBe(401);
  });

  test("a plan is private unless the upload asked otherwise", async () => {
    const key = await app.account();
    const created = await createPlan(key, html("secret"), {
      visibility: "private",
    });

    const gated = await app.fetch(`/p/${created.id}`);
    expect(gated.status).toBe(401);
    expect(gated.headers.get("content-type")).toStartWith("text/html");

    // No `?visibility=` at all is the same thing, and is what a client that
    // predates this feature sends.
    const response = await app.fetch("/api/plans", upload(key, html("bare")));
    expect(response.status).toBe(201);
    const bare = (await response.json()) as Created;
    expect((await app.fetch(`/p/${bare.id}`)).status).toBe(401);
  });

  test("a public plan is served to anyone, revalidated on every read", async () => {
    const key = await app.account();
    const created = await createPlan(key, html("open"), {
      visibility: "public",
    });

    const served = await app.fetch(`/p/${created.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("public, no-cache");
  });

  test("an unusable visibility is refused before a row is written", async () => {
    const key = await app.account();
    const countPlans = async () =>
      (
        await app.db
          .prepare("select count(*) as total from plan")
          .first<{ total: number }>()
      )?.total ?? -1;

    const before = await countPlans();
    const response = await app.fetch(
      "/api/plans?visibility=nonsense",
      upload(key, html("rejected")),
    );

    expect(response.status).toBe(400);
    expect(await jsonBody(response)).toEqual({
      error: "visibility must be public, private, or code",
    });
    // Nothing was claimed: the parse happens before the body is even read, so
    // a refusal cannot leave a row behind with no object.
    expect(await countPlans()).toBe(before);
  });

  test("no response carrying a plaintext code may be cached", async () => {
    const { key, cookie } = await app.accountWithSession();

    // The upload that mints one.
    const upload201 = await app.fetch(
      "/api/plans?visibility=code",
      upload(key, html("uncacheable")),
    );
    expect(upload201.status).toBe(201);
    expect(upload201.headers.get("cache-control")).toBe("no-store");
    const created = (await upload201.json()) as Created;

    // And the rotate that mints another.
    const rotated = await app.fetch(`/api/plans/${created.id}/share-code`, {
      method: "POST",
      headers: { cookie },
    });
    expect(rotated.status).toBe(201);
    expect(rotated.headers.get("cache-control")).toBe("no-store");

    // The sharing state names every account a plan is shared with.
    const sharing = await app.fetch(`/api/plans/${created.id}/sharing`, {
      headers: { cookie },
    });
    // Status first, like the two above: a 404 also carries `no-store`, so the
    // header alone would pass on a request that never reached the handler.
    expect(sharing.status).toBe(200);
    expect(sharing.headers.get("cache-control")).toBe("no-store");
  });

  test("?visibility=code returns the plaintext once and stores it private", async () => {
    const { key, cookie } = await app.accountWithSession();
    const created = await createPlan(key, html("coded"), {
      visibility: "code",
    });

    expect(created.code).toMatch(
      new RegExp(`^[0-9A-Za-z]{${SHARE_CODE_LENGTH}}$`),
    );

    const listed = await app.fetch("/api/plans", { headers: { cookie } });
    const body = await listed.text();
    const plans = (JSON.parse(body) as { plans: Record<string, unknown>[] })
      .plans;
    expect(plans[0]).toMatchObject({
      id: created.id,
      visibility: "private",
      hasShareCode: true,
    });
    // The one place the plaintext ever appears is the 201 above.
    expect(body).not.toContain(created.code ?? "never");
  });

  test("?code= serves the plan and hands back a cookie for next time", async () => {
    const key = await app.account();
    const document = html("code shared");
    const created = await createPlan(key, document, { visibility: "code" });

    const served = await app.fetch(`/p/${created.id}?code=${created.code}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(document);
    expect(served.headers.get("cache-control")).toBe("private, no-store");
    expect(served.headers.get("vary")).toBe("cookie, x-api-key");
    // Still sandboxed: the gate does not loosen the policy on the way past.
    expect(served.headers.get("content-security-policy")).toBe(PLAN_CSP);
    // This cookie is a bearer credential for the plan, so its attributes are
    // the control, not decoration: path-scoped so a browser never sends it to
    // another plan, HttpOnly so a script on the page cannot read it, and
    // SameSite so a cross-site request cannot ride it. `Secure` is not
    // asserted here on purpose - this harness serves over http, where
    // `mintShareCookie` omits it; tests/share-auth.test.ts covers both sides
    // of that.
    const cookie = served.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`Path=/p/${created.id}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    // The parameter is needed once.
    const returning = await app.fetch(`/p/${created.id}`, {
      headers: { cookie: shareCookie(served) },
    });
    expect(returning.status).toBe(200);
    expect(await returning.text()).toBe(document);
  });

  test("a wrong code, and another plan's code, both stay out", async () => {
    const key = await app.account();
    const mine = await createPlan(key, html("mine"), { visibility: "code" });
    const theirs = await createPlan(key, html("theirs"), {
      visibility: "code",
    });

    expect((await app.fetch(`/p/${mine.id}?code=wrong`)).status).toBe(401);
    // A code is scoped to the plan it was minted for, not to the account.
    expect((await app.fetch(`/p/${mine.id}?code=${theirs.code}`)).status).toBe(
      401,
    );
  });

  test("a public plan ignores the parameter entirely", async () => {
    const key = await app.account();
    const created = await createPlan(key, html("open"), {
      visibility: "public",
    });

    const served = await app.fetch(`/p/${created.id}?code=anything`);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("public, no-cache");
  });

  test("either of the owner's credentials opens the gate; a stranger's does not", async () => {
    const owner = await app.accountWithSession();
    const stranger = await app.accountWithSession();
    const created = await createPlan(owner.key, html("owned"), {
      visibility: "private",
    });

    const byKey = await app.fetch(`/p/${created.id}`, {
      headers: { "x-api-key": owner.key },
    });
    expect(byKey.status).toBe(200);
    expect(byKey.headers.get("cache-control")).toBe("private, no-store");

    const bySession = await app.fetch(`/p/${created.id}`, {
      headers: { cookie: owner.cookie },
    });
    expect(bySession.status).toBe(200);

    expect((await app.fetch(`/p/${created.id}`)).status).toBe(401);
    expect(
      (
        await app.fetch(`/p/${created.id}`, {
          headers: { "x-api-key": stranger.key },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(`/p/${created.id}`, {
          headers: { cookie: stranger.cookie },
        })
      ).status,
    ).toBe(401);
  });

  test("a grant authorises the account, whichever credential it presents", async () => {
    const owner = await app.accountWithSession();
    const guest = await app.accountWithSession();
    const created = await createPlan(owner.key, html("granted"), {
      visibility: "private",
    });

    const granted = await app.fetch(`/api/plans/${created.id}/grants`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({ accounts: guest.handle }),
    });
    expect(granted.status).toBe(200);

    // The gate authorises the user behind a credential, not a credential type.
    for (const headers of [
      { "x-api-key": guest.key },
      { cookie: guest.cookie },
    ]) {
      expect((await app.fetch(`/p/${created.id}`, { headers })).status).toBe(
        200,
      );
    }

    const revoked = await app.fetch(
      `/api/plans/${created.id}/grants/${guest.handle}`,
      { method: "DELETE", headers: { cookie: owner.cookie } },
    );
    expect(revoked.status).toBe(204);

    for (const headers of [
      { "x-api-key": guest.key },
      { cookie: guest.cookie },
    ]) {
      expect((await app.fetch(`/p/${created.id}`, { headers })).status).toBe(
        401,
      );
    }
  });

  test("granting an unknown handle says so, distinctly from an unknown plan", async () => {
    const owner = await app.accountWithSession();
    const created = await createPlan(owner.key, html("granting"), {
      visibility: "private",
    });

    const unknown = await app.fetch(`/api/plans/${created.id}/grants`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({ accounts: "nobodyatall" }),
    });
    // Reported rather than fatal: naming five colleagues and mistyping one
    // must still share the plan with the four.
    expect(unknown.status).toBe(200);
    expect(await jsonBody(unknown)).toEqual({
      granted: [],
      unknown: ["nobodyatall"],
      failed: [],
    });
  });

  test("one request shares a plan with a whole list", async () => {
    const owner = await app.accountWithSession();
    const first = await app.accountWithSession();
    const second = await app.accountWithSession();
    const created = await createPlan(owner.key, html("team"), {
      visibility: "private",
    });

    const granted = await app.fetch(`/api/plans/${created.id}/grants`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        accounts: ` ${first.handle}, ${second.handle} ,nobodyatall,`,
      }),
    });
    expect(granted.status).toBe(200);
    expect(await jsonBody(granted)).toEqual({
      granted: [first.handle, second.handle],
      unknown: ["nobodyatall"],
      failed: [],
    });

    // Both can actually read it, which is the point of the request.
    for (const account of [first, second]) {
      const served = await app.fetch(`/p/${created.id}`, {
        headers: { cookie: account.cookie },
      });
      expect(served.status).toBe(200);
    }

    const sharing = await app.fetch(`/api/plans/${created.id}/sharing`, {
      headers: { cookie: owner.cookie },
    });
    expect((await jsonBody(sharing))["grants"]).toEqual(
      expect.arrayContaining([first.handle, second.handle]),
    );
  });

  test("a list may name accounts by id as readily as by handle", async () => {
    // The dashboard shows a handle, but `/api/auth/get-session` hands the
    // signed-in account its id, so a script is likelier to hold that.
    const owner = await app.accountWithSession();
    const byId = await app.accountWithSession();
    const byHandle = await app.accountWithSession();
    const created = await createPlan(owner.key, html("mixed"), {
      visibility: "private",
    });

    const granted = await app.fetch(`/api/plans/${created.id}/grants`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        accounts: `${byId.userId}, ${byHandle.handle}`,
      }),
    });
    expect(granted.status).toBe(200);
    // Echoed back as given, so a caller can match the answer to what it sent.
    expect(await jsonBody(granted)).toEqual({
      granted: [byId.userId, byHandle.handle],
      unknown: [],
      failed: [],
    });

    for (const account of [byId, byHandle]) {
      const served = await app.fetch(`/p/${created.id}`, {
        headers: { cookie: account.cookie },
      });
      expect(served.status).toBe(200);
    }

    // The sharing list answers in handles either way: that is the identifier
    // a person can read off their own dashboard.
    const sharing = await app.fetch(`/api/plans/${created.id}/sharing`, {
      headers: { cookie: owner.cookie },
    });
    expect((await jsonBody(sharing))["grants"]).toEqual(
      expect.arrayContaining([byId.handle, byHandle.handle]),
    );
  });

  test("?grants= takes account ids too", async () => {
    const owner = await app.accountWithSession();
    const guest = await app.accountWithSession();
    const created = await createPlan(owner.key, html("id-at-upload"), {
      visibility: "private",
      grants: guest.userId,
    });

    expect(created.granted).toEqual([guest.userId]);
    const served = await app.fetch(`/p/${created.id}`, {
      headers: { cookie: guest.cookie },
    });
    expect(served.status).toBe(200);
  });

  test("?grants= shares the plan in the request that stores it", async () => {
    // So a private plan never has to exist unshared, even briefly.
    const owner = await app.accountWithSession();
    const guest = await app.accountWithSession();
    const created = await createPlan(owner.key, html("born-shared"), {
      visibility: "private",
      grants: `${guest.handle},nobodyatall`,
    });

    expect(created.granted).toEqual([guest.handle]);
    expect(created.unknown).toEqual(["nobodyatall"]);

    const served = await app.fetch(`/p/${created.id}`, {
      headers: { cookie: guest.cookie },
    });
    expect(served.status).toBe(200);

    // Still private: naming accounts is not the same as publishing.
    const gated = await app.fetch(`/p/${created.id}`);
    expect(gated.status).toBe(401);
  });

  test("an upload naming nobody carries no grant fields at all", async () => {
    const owner = await app.accountWithSession();
    const created = await createPlan(owner.key, html("solo"), {
      visibility: "private",
    });
    expect(created.granted).toBeUndefined();
    expect(created.unknown).toBeUndefined();
  });

  test("an unusable ?grants= is refused before a row is written", async () => {
    const owner = await app.accountWithSession();
    const countPlans = async () =>
      (
        await app.db
          .prepare("select count(*) as total from plan")
          .first<{ total: number }>()
      )?.total ?? -1;

    const before = await countPlans();
    // Present but empty: `?grants=` with nothing usable after it is a typo,
    // not a request to share with nobody.
    const response = await app.fetch(
      "/api/plans?visibility=private&grants=%20%2C%20",
      upload(owner.key, html("rejected")),
    );
    expect(response.status).toBe(400);
    expect(await countPlans()).toBe(before);
  });

  test("a key is not a skeleton key for sharing management", async () => {
    const owner = await app.accountWithSession();
    const created = await createPlan(owner.key, html("managed"), {
      visibility: "private",
    });

    // It reads the plan, but it cannot see or change who else may.
    expect(
      (
        await app.fetch(`/p/${created.id}`, {
          headers: { "x-api-key": owner.key },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(`/api/plans/${created.id}/sharing`, {
          headers: { "x-api-key": owner.key },
        })
      ).status,
    ).toBe(401);
  });

  test("the owner mints, redeems, rotates, and clears a code", async () => {
    const owner = await app.accountWithSession();
    const document = html("rotating");
    const created = await createPlan(owner.key, document, {
      visibility: "private",
    });
    const session = { cookie: owner.cookie };

    const minted = await app.fetch(`/api/plans/${created.id}/share-code`, {
      method: "POST",
      headers: session,
    });
    expect(minted.status).toBe(201);
    const first = ((await minted.json()) as { code: string }).code;
    expect(first).toMatch(new RegExp(`^[0-9A-Za-z]{${SHARE_CODE_LENGTH}}$`));

    const unlocked = await app.fetch(`/api/plans/${created.id}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: first }),
    });
    expect(unlocked.status).toBe(204);
    const firstCookie = shareCookie(unlocked);

    const served = await app.fetch(`/p/${created.id}`, {
      headers: { cookie: firstCookie },
    });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(document);

    const wrong = await app.fetch(`/api/plans/${created.id}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "definitely-not-it" }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    // Rotating binds a new digest, and the cookie carries the old one - so
    // every outstanding cookie dies with no column to sweep.
    const rotated = await app.fetch(`/api/plans/${created.id}/share-code`, {
      method: "POST",
      headers: session,
    });
    expect(rotated.status).toBe(201);
    const second = ((await rotated.json()) as { code: string }).code;
    expect(second).not.toBe(first);

    expect(
      (
        await app.fetch(`/p/${created.id}`, {
          headers: { cookie: firstCookie },
        })
      ).status,
    ).toBe(401);
    expect((await app.fetch(`/p/${created.id}?code=${first}`)).status).toBe(
      401,
    );
    expect((await app.fetch(`/p/${created.id}?code=${second}`)).status).toBe(
      200,
    );

    // Redeem the rotated code, so there is a live cookie to invalidate.
    const reUnlocked = await app.fetch(`/api/plans/${created.id}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: second }),
    });
    expect(reUnlocked.status).toBe(204);
    const secondCookie = shareCookie(reUnlocked);
    expect(
      (
        await app.fetch(`/p/${created.id}`, {
          headers: { cookie: secondCookie },
        })
      ).status,
    ).toBe(200);

    const cleared = await app.fetch(`/api/plans/${created.id}/share-code`, {
      method: "DELETE",
      headers: session,
    });
    expect(cleared.status).toBe(204);

    // Clearing has to reach the readers already holding a cookie, not just
    // stop new redemptions - the cookie carries the digest, so removing the
    // column is what retires it.
    expect(
      (
        await app.fetch(`/p/${created.id}`, {
          headers: { cookie: secondCookie },
        })
      ).status,
    ).toBe(401);

    // With no code at all the endpoint cannot say a plan is code-shared.
    const afterClear = await app.fetch(`/api/plans/${created.id}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: second }),
    });
    expect(afterClear.status).toBe(404);
  });

  test("the sharing state reports visibility, the code flag, and grants", async () => {
    const owner = await app.accountWithSession();
    const guest = await app.accountWithSession();
    const created = await createPlan(owner.key, html("state"), {
      visibility: "private",
    });
    const session = { cookie: owner.cookie };

    const initial = await app.fetch(`/api/plans/${created.id}/sharing`, {
      headers: session,
    });
    expect(initial.status).toBe(200);
    expect(await jsonBody(initial)).toEqual({
      visibility: "private",
      hasShareCode: false,
      grants: [],
    });

    await app.fetch(`/api/plans/${created.id}/share-code`, {
      method: "POST",
      headers: session,
    });
    await app.fetch(`/api/plans/${created.id}/grants`, {
      method: "POST",
      headers: { ...session, "content-type": "application/json" },
      body: JSON.stringify({ accounts: guest.handle }),
    });

    const flipped = await app.fetch(`/api/plans/${created.id}/sharing`, {
      method: "PUT",
      headers: { ...session, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(flipped.status).toBe(200);
    expect(await jsonBody(flipped)).toEqual({
      visibility: "public",
      hasShareCode: true,
      grants: [guest.handle],
    });

    // `code` is an upload intent, not a state this endpoint can be flipped to.
    const refused = await app.fetch(`/api/plans/${created.id}/sharing`, {
      method: "PUT",
      headers: { ...session, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "code" }),
    });
    expect(refused.status).toBe(400);
    expect(await jsonBody(refused)).toEqual({
      error: "visibility must be public or private",
    });
  });

  test("every sharing route refuses no session and a stranger's session", async () => {
    const owner = await app.accountWithSession();
    const stranger = await app.accountWithSession();
    const created = await createPlan(owner.key, html("guarded"), {
      visibility: "private",
    });
    const json = { "content-type": "application/json" };

    // Headers typed as a plain record, not `HeadersInit`: the loop below
    // spreads them to add a cookie, and spreading a `Headers` instance would
    // silently yield `{}` and drop the content type.
    type Route = {
      path: string;
      init: Omit<NonNullable<FetchInit>, "headers"> & {
        headers?: Record<string, string>;
      };
    };
    const routes: Route[] = [
      { path: `/api/plans/${created.id}/sharing`, init: { method: "GET" } },
      {
        path: `/api/plans/${created.id}/sharing`,
        init: {
          method: "PUT",
          headers: json,
          body: '{"visibility":"public"}',
        },
      },
      {
        path: `/api/plans/${created.id}/share-code`,
        init: { method: "POST" },
      },
      {
        path: `/api/plans/${created.id}/share-code`,
        init: { method: "DELETE" },
      },
      {
        path: `/api/plans/${created.id}/grants`,
        init: { method: "POST", headers: json, body: '{"accounts":"someone"}' },
      },
      {
        path: `/api/plans/${created.id}/grants/${stranger.handle}`,
        init: { method: "DELETE" },
      },
    ];

    for (const { path, init } of routes) {
      const anonymous = await app.fetch(path, init);
      expect(anonymous.status).toBe(401);

      const headers = { ...(init.headers ?? {}), cookie: stranger.cookie };
      const outsider = await app.fetch(path, { ...init, headers });
      // Not 403: never confirm that someone else's plan id exists.
      expect(outsider.status).toBe(404);
    }
  });
});
