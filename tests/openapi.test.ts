import { describe, expect, test } from "bun:test";
import { validate } from "@scalar/openapi-parser";
import { openApiDocument } from "../src/api/openapi.ts";
import { createApp } from "../src/app.ts";

const CONFIG = {
  publicBaseUrl: "https://plans.example.test",
  maxUploadBytes: 1234,
  shareCodeLength: 24,
};

const doc = openApiDocument(CONFIG);

/** `ALL` is how Hono records `app.use` middleware and `app.all` routes. */
const ROUTER_METHODS: Record<string, true> = {
  all: true,
  get: true,
  put: true,
  post: true,
  patch: true,
  delete: true,
  head: true,
  options: true,
  trace: true,
};

/** The verbs an OpenAPI path item may carry. */
const HTTP_METHODS: Record<string, true> = {
  get: true,
  put: true,
  post: true,
  patch: true,
  delete: true,
  head: true,
  options: true,
  trace: true,
};

/**
 * Routes the document deliberately leaves out.
 *
 * `/api/auth/*` belongs to Better Auth: its surface follows the plugin set,
 * and hand-describing it here is the drift the document exists to avoid. The
 * other two are the documentation itself, and the rest are pages rather than
 * API endpoints.
 */
const UNDOCUMENTED: Record<string, true> = {
  // The security-header middleware, which is not an endpoint.
  "/*": true,
  "/api/auth/*": true,
  "/api/docs": true,
  "/api/openapi.json": true,
  "/": true,
  "/dashboard": true,
  /*
   * The share-link relay: a page, and one an API client never calls. It exists
   * because a share code rides in a fragment and `/p/{id}` answers an
   * authorised reader with untrusted HTML that could read its own
   * `location.hash`. What a client needs is how to compose the link, and that
   * is described on both endpoints that hand a code out.
   *
   * Those two are `PUT /api/plans` with `?visibility=code` - the upload, at
   * `app.put("/api/plans")` in src/app.ts, with the intent declared as
   * `UploadVisibility` in src/http/plan-visibility.ts - and
   * `POST /api/plans/{id}/share-code`. Neither is `POST /api/plans`, which
   * does not exist, and `PUT /api/plans/{id}/sharing` mints no code: its body
   * takes `public` or `private` and has no `"code"` intent at all.
   */
  "/s/{id}": true,
};

/** Hono's `/api/plans/:id` is the document's `/api/plans/{id}`. */
function documented(path: string): string {
  return path.replaceAll(/:([^/]+)/g, "{$1}").replace("{planId}", "{id}");
}

/**
 * Every route the app answers, taken from Hono's own routing table rather
 * than restated here. A new endpoint that nobody documented fails this file
 * instead of shipping undescribed.
 *
 * `getServices` throws because registration must not call it - a route that
 * resolved services at construction time would break `/healthz` on Workers,
 * which has to refuse before any service lookup.
 */
function servedRoutes(): Map<string, Set<string>> {
  const app = createApp({
    getServices: () => {
      throw new Error("services must not be resolved while registering routes");
    },
    runtime: "node",
    assets: { script: "/entry.js", stylesheet: "/entry.css" },
  });

  const routes = new Map<string, Set<string>>();
  for (const route of app.routes) {
    const method = route.method.toLowerCase();
    if (ROUTER_METHODS[method] !== true) continue;
    const path = documented(route.path);
    const methods = routes.get(path) ?? new Set<string>();
    methods.add(method);
    routes.set(path, methods);
  }
  return routes;
}

describe("the published document", () => {
  // Validated after a round trip through JSON, which is the form that is
  // actually served - `undefined` and non-enumerable properties do not
  // survive it, and neither should the assertion.
  test("is valid OpenAPI 3.1", async () => {
    const result = await validate(JSON.parse(JSON.stringify(doc)));
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.version).toBe("3.1");
  });

  test("reports this deployment rather than the repository's defaults", () => {
    expect(doc.servers).toEqual([
      { url: CONFIG.publicBaseUrl, description: "This deployment." },
    ]);

    const tooLarge = doc.paths["/api/plans"]?.["put"] as {
      responses: Record<string, { description: string }>;
    };
    expect(tooLarge.responses["413"]?.description).toContain(
      String(CONFIG.maxUploadBytes),
    );
  });

  /**
   * `describeShareCode` writes this at build time because a Zod component is
   * a module-level singleton and cannot hold a per-deployment value. Nothing
   * else would notice if that write silently stopped landing.
   */
  test("publishes this deployment's share-code length, not the default", () => {
    const codeOf = (name: string) => {
      const schema = doc.components.schemas[name] as {
        properties: Record<string, { description?: string }>;
      };
      return schema.properties["code"]?.description ?? "";
    };

    for (const name of ["PlanCreated", "ShareCodeCreated"]) {
      expect(codeOf(name)).toContain(`${CONFIG.shareCodeLength} characters`);
      // The repository default must not leak through in its place.
      expect(codeOf(name)).not.toContain("16 characters");
    }

    const createPlan = doc.paths["/api/plans"]?.["put"] as {
      description: string;
    };
    expect(createPlan.description).toContain(
      `${CONFIG.shareCodeLength} characters`,
    );
  });

  test("every $ref points at a component that exists", () => {
    const names = new Set(Object.keys(doc.components.schemas));
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );

    expect(refs.length).toBeGreaterThan(0);
    for (const target of refs) {
      expect(target).toStartWith("#/components/schemas/");
      expect(names).toContain(target.slice("#/components/schemas/".length));
    }
  });

  /**
   * Zod emits a synthetic `__shared` entry for a schema that is reused but
   * unregistered, and references it as `#/components/schemas/__shared#/$defs/x`
   * - two fragments, which resolves nowhere. Nothing else would notice.
   */
  test("carries no synthetic shared-definitions entry", () => {
    expect(Object.keys(doc.components.schemas)).not.toContain("__shared");
  });
});

describe("coverage of the routes the app actually serves", () => {
  const routes = servedRoutes();

  test("the router table holds the endpoints we expect", () => {
    expect([...routes.keys()].sort()).toEqual([
      "/",
      "/*",
      "/api/auth/*",
      "/api/docs",
      "/api/openapi.json",
      "/api/plans",
      "/api/plans/{id}",
      "/api/plans/{id}/grants",
      "/api/plans/{id}/grants/{handle}",
      "/api/plans/{id}/share-code",
      "/api/plans/{id}/sharing",
      "/api/plans/{id}/unlock",
      "/dashboard",
      "/healthz",
      "/p/{id}",
      "/s/{id}",
    ]);
  });

  test("every served route is described or deliberately excluded", () => {
    const described = new Set(Object.keys(doc.paths));
    for (const path of routes.keys()) {
      if (UNDOCUMENTED[path] === true) continue;
      expect(described).toContain(path);
    }
  });

  test("every described route has every method the router answers", () => {
    for (const [path, methods] of routes) {
      if (UNDOCUMENTED[path] === true) continue;
      const item = doc.paths[path] ?? {};
      const listed = Object.keys(item).filter(
        (key) => HTTP_METHODS[key] === true,
      );
      expect(listed.sort()).toEqual([...methods].sort());
    }
  });

  test("describes no route the app does not serve", () => {
    const served = new Set(routes.keys());
    for (const path of Object.keys(doc.paths)) {
      expect(served).toContain(path);
    }
  });
});
