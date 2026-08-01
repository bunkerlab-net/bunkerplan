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
 * Routes the document deliberately leaves out whole.
 *
 * `/api/auth/*` belongs to Better Auth: its surface follows the plugin set,
 * and hand-describing it here is the drift the document exists to avoid. The
 * other two are the documentation itself, and the rest are pages rather than
 * API endpoints. Routes left out because a key cannot call them are in
 * `SESSION_ONLY` instead.
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
   * is described on both endpoints that hand a code out. Documenting the page
   * itself would put a browser route in a document whose every other entry is
   * something a client calls - `/dashboard` is left out for the same reason,
   * and `/p/{id}` is in because a client can fetch a plan.
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

/**
 * Session-only operations, which the document describes nowhere: it publishes
 * the API-key surface, and a `session` security scheme would offer a reader
 * holding a key a cookie only a browser can obtain. Listed per method, because
 * `/api/plans/{id}` carries both kinds - a key replaces, relabels, and deletes;
 * only widening a plan's audience needs the dashboard.
 *
 * Spelled out rather than derived, so widening one of these to accept a key is
 * a deliberate edit here as well as in src/http/*, and a new session-only
 * route has to be classified rather than quietly omitted.
 */
const SESSION_ONLY: Record<string, Set<string>> = {
  "/api/plans/{id}/sharing": new Set(["get", "put"]),
  "/api/plans/{id}/share-code": new Set(["post", "delete"]),
  "/api/plans/{id}/grants": new Set(["post"]),
  "/api/plans/{id}/grants/{handle}": new Set(["delete"]),
};

/** The methods on `path` the document is expected to describe. */
function expected(path: string, served: Set<string>): string[] {
  const excluded = SESSION_ONLY[path];
  const kept = [...served].filter((method) => excluded?.has(method) !== true);
  return kept.sort();
}

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

/**
 * Operations that ask for nothing, and why. Everything else in the document
 * must ask for the key: an operation that quietly regresses to `security: []`
 * publishes "no credential needed here", which is the inverse of the truth and
 * is a plausible edit, because two neighbours legitimately carry it.
 */
const PUBLIC_OPERATIONS: Record<string, Array<Record<string, unknown>>> = {
  // Redeeming a share code authorises on the code in the body.
  "post /api/plans/{id}/unlock": [],
  // A self-hosting probe.
  "get /healthz": [],
  // A public plan needs nothing; a private one takes the key, the code, or the
  // unlock cookie - the last two are parameters rather than schemes.
  "get /p/{id}": [{}, { apiKey: [] }],
};

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
   * The upload's 503, which a client has to be told apart from a 500 to know
   * that repeating the request is both safe and worth doing. Nothing was
   * stored when it is returned, so an undocumented one reads as a fault and
   * gets reported rather than retried.
   */
  test("publishes the retryable upload failure, with its wait", () => {
    const upload = doc.paths["/api/plans"]?.["put"] as {
      responses: Record<
        string,
        {
          description: string;
          headers?: Record<string, { description: string; schema: unknown }>;
        }
      >;
    };

    const busy = upload.responses["503"];
    // Both halves of the advice: that the attempt changed nothing, and that
    // repeating it is the thing to do. Either alone leaves a client guessing.
    expect(busy?.description).toContain("Nothing was stored");
    expect(busy?.description).toContain("repeating the request is safe");

    // The header is the wait itself, so its shape is part of the contract - a
    // client reads a number out of it. Documented without a schema it is a
    // string as far as a generated client is concerned.
    const wait = busy?.headers?.["retry-after"];
    expect(wait?.description).toContain("Seconds");
    expect(wait?.schema).toEqual({ type: "integer", minimum: 0 });
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

    expect(codeOf("PlanCreated")).toContain(
      `${CONFIG.shareCodeLength} characters`,
    );
    // The repository default must not leak through in its place.
    expect(codeOf("PlanCreated")).not.toContain("16 characters");

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

  /**
   * The document is scoped to what an API key can call, so `apiKey` is the
   * only credential any operation may ask for. A `session` scheme creeping
   * back in - or an operation naming one that is not declared - is what this
   * catches.
   */
  test("offers no credential but the API key", () => {
    expect(Object.keys(doc.components.securitySchemes)).toEqual(["apiKey"]);

    const named = new Set<string>();
    const seen = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (HTTP_METHODS[method] !== true) continue;
        seen.add(`${method} ${path}`);
        const { security } = operation as {
          security?: Array<Record<string, unknown>>;
        };
        // Every operation declares one: the document has no top-level
        // `security`, so an omission would inherit nothing and mean nothing.
        expect(security).toBeDefined();
        // Per operation, not as a union: a union stays green while one
        // operation drops its requirement, as long as another still names it.
        expect(security).toEqual(
          PUBLIC_OPERATIONS[`${method} ${path}`] ?? [{ apiKey: [] }],
        );
        // `{}` is "no credential needed here" and names no scheme at all.
        for (const alternative of security ?? []) {
          for (const name of Object.keys(alternative)) named.add(name);
        }
      }
    }

    expect(seen.size).toBeGreaterThan(0);
    // The same staleness guard `SESSION_ONLY` gets: an exemption whose
    // operation is gone stops exempting anything and starts waiting to excuse
    // whatever is added at that method and path next.
    for (const key of Object.keys(PUBLIC_OPERATIONS)) {
      expect(seen).toContain(key);
    }
    expect([...named]).toEqual(["apiKey"]);
  });

  /**
   * The other half of "every `$ref` resolves": a component nothing points at.
   * `componentSchemas` emits the response shapes of the session-only routes
   * too, and a rendered reference lists components whether an operation names
   * one or not - so an orphan would put `PlanSharing` in front of a reader who
   * has just been told sharing lives elsewhere.
   */
  test("publishes no component nothing points at", () => {
    const refs = new Set(
      [...JSON.stringify(doc).matchAll(/"\$ref":"([^"]+)"/g)].map((match) =>
        (match[1] ?? "").slice("#/components/schemas/".length),
      ),
    );

    expect(refs.size).toBeGreaterThan(0);
    expect(Object.keys(doc.components.schemas).sort()).toEqual(
      [...refs].sort(),
    );

    // Named rather than only implied, because the two sides above are equal by
    // construction: these are the shapes `componentSchemas` still emits for the
    // session-only handlers, and none of them may reach the document.
    for (const name of [
      "PlanSharing",
      "ShareCodeCreated",
      "GrantRequest",
      "GrantResult",
      "SharingRequest",
    ]) {
      expect(doc.components.schemas[name]).toBeUndefined();
    }
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

  /**
   * A stale entry is as bad as a missing one: it would keep excusing a path the
   * app no longer serves, and if a route were widened to accept a key while its
   * entry stayed, the document would go on under-describing the key surface with
   * every other test green.
   *
   * Containment, not equality: the map is per method precisely so a path may
   * carry both kinds, and a new session-only method on one of these paths is
   * caught by the coverage tests below rather than here.
   */
  test("names only session-only operations the app still serves", () => {
    for (const [path, methods] of Object.entries(SESSION_ONLY)) {
      const served = routes.get(path);
      expect(served).toBeDefined();
      for (const method of methods) expect(served).toContain(method);
    }
  });

  test("every served route is described or deliberately excluded", () => {
    const described = new Set(Object.keys(doc.paths));
    for (const [path, methods] of routes) {
      if (UNDOCUMENTED[path] === true) continue;
      if (expected(path, methods).length === 0) {
        expect(described).not.toContain(path);
        continue;
      }
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
      expect(listed.sort()).toEqual(expected(path, methods));
    }
  });

  test("describes no route the app does not serve", () => {
    const served = new Set(routes.keys());
    for (const path of Object.keys(doc.paths)) {
      expect(served).toContain(path);
    }
  });
});
