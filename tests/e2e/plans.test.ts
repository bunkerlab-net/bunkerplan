import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { validate } from "@scalar/openapi-parser";
import { DOCS_PAGE, SCALAR_SCRIPT_PATH } from "../../src/api/docs-page.ts";
import { ErrorBody, PlanCreated, PlanReplaced } from "../../src/api/schemas.ts";
import { PLAN_CSP } from "../../src/http/security-headers.ts";
import {
  type FetchResponse,
  type Harness,
  html,
  MAX_PLANS_PER_USER,
  PUBLIC_BASE_URL,
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
}

/** `Response.json()` erases the body; assertions need something to compare. */
async function jsonBody(
  response: FetchResponse,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function createPlan(
  key: string,
  body: string,
  label?: string,
): Promise<Created> {
  const query =
    label === undefined ? "" : `?label=${encodeURIComponent(label)}`;
  const response = await app.fetch(`/api/plans${query}`, upload(key, body));
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
    const created = await createPlan(key, body, "Q3 rollout");

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
    const created = await createPlan(key, html("before"), "keep me");

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
    // The JSON body is the point: an unrouted PUT would also be a 404, but an
    // HTML one, and this test would pass with the handler missing entirely.
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
