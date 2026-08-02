import { type AppDeps, createApp } from "../src/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import type { AssetManifest } from "../src/server/assets.ts";
import type { Services } from "../src/services/context.ts";
import type {
  AccountClosingRepo,
  Db,
  KvStore,
  PlanObject,
  PlanRepo,
  PlanStorage,
  RateLimitRepo,
  RuntimeTarget,
} from "../src/services/types.ts";
import {
  type AuthCalls,
  fakeAuth,
  memoryPlans,
  silentLogger,
} from "./fakes.ts";

/**
 * The whole app, in this process, over fakes.
 *
 * tests/e2e runs the real Worker on the real local stack and stays the
 * authority on behaviour end to end - but it runs inside workerd, where the
 * coverage profiler cannot see it, and there are refusals it cannot stage at
 * all: a repository that throws, an object that vanishes between the access
 * check and the read, a probe that never returns.
 *
 * This is the other half. `createApp` is the real router with the real
 * middleware; the backends are the fakes in tests/fakes.ts, and each one is a
 * plain object a test can make misbehave.
 */

export const PUBLIC_BASE_URL = "https://plans.example.test";

/**
 * The header the unlock throttle identifies a caller by. Configuration refuses
 * to load without one, so a request that omits it is refused rather than
 * counted - which is a case worth reaching, so it is named here.
 */
export const CLIENT_IP_HEADER = "x-forwarded-for";
export const CLIENT_IP = "203.0.113.7";

/**
 * Built by the real loader rather than cast into shape, so every field these
 * suites do not name - `rpId`, the log settings, the driver block - holds what
 * production would hold instead of `undefined` behind a type that promises
 * otherwise.
 */
export const CONFIG: Config = loadConfig(
  {
    BETTER_AUTH_SECRET: "app-harness-secret-0123456789abcdef",
    PUBLIC_BASE_URL,
    CLIENT_IP_HEADER,
    MAX_UPLOAD_BYTES: String(2 * 1024 * 1024),
    PLAN_ID_LENGTH: "16",
    SHARE_CODE_LENGTH: "16",
    MAX_PLANS_PER_USER: "10",
    UPLOAD_RATE_MAX: "100",
    UPLOAD_RATE_WINDOW_SEC: "60",
    UNLOCK_RATE_MAX: "100",
    UNLOCK_RATE_WINDOW_SEC: "60",
    // A driver set has to be named for the loader to accept the environment.
    // Nothing here reaches it: every suite supplies its own repositories.
    STORAGE_DRIVER: "s3",
    S3_BUCKET: "plans",
    DB_DRIVER: "postgres",
    DATABASE_URL: "postgres://localhost/plans",
    KV_DRIVER: "valkey",
    VALKEY_URL: "redis://localhost:6379",
  },
  {},
);

export const ASSETS: AssetManifest = {
  script: "/assets/entry-deadbeef.js",
  stylesheet: "/assets/entry-deadbeef.css",
};

/** The in-memory storage, which also hands back the objects it is holding. */
export type MemoryStorage = PlanStorage & {
  objects: Map<string, Uint8Array<ArrayBufferLike>>;
};

export function memoryStorage(
  seed: Record<string, string> = {},
): MemoryStorage {
  const objects = new Map<string, Uint8Array<ArrayBufferLike>>(
    Object.entries(seed).map(([id, body]) => [
      id,
      new TextEncoder().encode(body),
    ]),
  );
  return {
    objects,
    put: async (id, body) => {
      // A copy, because a real bucket keeps the bytes it was handed: retaining
      // the caller's buffer lets a later mutation of it silently rewrite a
      // stored document and the etag derived from it.
      objects.set(id, new Uint8Array(body));
    },
    get: async (id): Promise<PlanObject | null> => {
      const bytes = objects.get(id);
      if (bytes === undefined) return null;
      return {
        body: new Response(bytes as BodyInit)
          .body as ReadableStream<Uint8Array>,
        size: bytes.byteLength,
        // Content-derived, so a replaced document gets a different tag and the
        // conditional-request tests mean something.
        etag: `"${Bun.hash(bytes).toString(16)}"`,
      };
    },
    delete: async (id) => {
      objects.delete(id);
    },
    probe: async () => {},
  };
}

export function memoryKv(): KvStore {
  const entries = new Map<string, string>();
  return {
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => {
      entries.set(key, value);
    },
    delete: async (key) => {
      entries.delete(key);
    },
    probe: async () => {},
  };
}

/** Allows everything; the limiters have suites of their own. */
export const openRateLimits: RateLimitRepo = {
  consume: async () => ({ allowed: true, retryAfter: 0, windowStart: 0 }),
  refund: async () => {},
};

/** Refuses everything. */
export const closedRateLimits: RateLimitRepo = {
  consume: async () => ({ allowed: false, retryAfter: 30 }),
  refund: async () => {},
};

/**
 * Nothing is closing.
 *
 * Deliberately stateless: no HTTP route calls `open` - only Better Auth's
 * `onBeforeDeleteUser` does - so nothing reachable through `buildApp` can
 * make `isOpen` answer differently. A fake that remembered would be
 * flexibility no test can drive. The suite that does drive the transition,
 * tests/upload-delete-race.test.ts, carries its own stateful one; a route test
 * wanting the closing branch passes `isOpen: async () => true`.
 */
export const openAccounts: AccountClosingRepo = {
  open: async () => "attempt",
  close: async () => {},
  isOpen: async () => false,
};

export interface HarnessOptions<S extends PlanStorage = MemoryStorage> {
  runtime?: RuntimeTarget;
  sessionUser?: string | null;
  keyUser?: string | null;
  authHandler?: (request: Request) => Promise<Response>;
  plans?: PlanRepo;
  storage?: S;
  kv?: KvStore;
  uploadRateLimits?: RateLimitRepo;
  unlockRateLimits?: RateLimitRepo;
  accountClosing?: AccountClosingRepo;
  config?: Config;
  /**
   * The database probe, which is the one `/healthz` failure this harness is
   * used to drive.
   *
   * Deliberately not widened to storage and KV probes: the suite that needs a
   * failing or hanging backend builds `Services` directly (see the health probe
   * block in tests/edge-cases.test.ts) because it also needs to assert which
   * names are reported. Adding overrides here would be a second way to do that
   * with no caller.
   */
  probe?: () => Promise<void>;
  /** Counts resolutions, so "not touched before the refusal" is observable. */
  onServices?: () => void;
}

export interface AppHarness<S extends PlanStorage = MemoryStorage> {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  plans: PlanRepo;
  /**
   * Whatever storage the app was built on, at its own type.
   *
   * Generic rather than always the memory one: a caller passing its own
   * `PlanStorage` has no `objects` map, and claiming otherwise handed those
   * suites a typed field that is `undefined` at runtime.
   */
  storage: S;
  auth: AuthCalls;
}

export function buildApp<S extends PlanStorage>(
  options: HarnessOptions<S> & { storage: S },
): AppHarness<S>;
export function buildApp(options?: HarnessOptions): AppHarness<MemoryStorage>;
export function buildApp(
  options: HarnessOptions<PlanStorage> = {},
): AppHarness<PlanStorage> {
  const { auth, calls } = fakeAuth({
    sessionUser: options.sessionUser ?? null,
    keyUser: options.keyUser ?? null,
    ...(options.authHandler === undefined
      ? {}
      : { handler: options.authHandler }),
  });
  const plans = options.plans ?? memoryPlans();
  const storage = options.storage ?? memoryStorage();
  const db: Db = {
    adapter: {},
    // Matches `CONFIG.dbDriver`. Nothing here reads it - `fakeAuth` stands in
    // for the auth instance, and the drizzle adapter in src/auth/instance.ts
    // is its only consumer - but a fixture naming two different databases is
    // a state no deployment can be in, and one a future reader could branch on.
    provider: "pg",
    plans,
    uploadRateLimits: options.uploadRateLimits ?? openRateLimits,
    unlockRateLimits: options.unlockRateLimits ?? openRateLimits,
    accountClosing: options.accountClosing ?? openAccounts,
    probe: options.probe ?? (async () => {}),
  };
  const services: Services = {
    config: options.config ?? CONFIG,
    auth,
    logger: silentLogger,
    storage,
    kv: options.kv ?? memoryKv(),
    db,
  };

  const deps: AppDeps = {
    getServices: async () => {
      options.onServices?.();
      return services;
    },
    runtime: options.runtime ?? "node",
    assets: ASSETS,
  };

  const app = createApp(deps);

  return {
    fetch: async (path, init) =>
      await app.request(new Request(new URL(path, PUBLIC_BASE_URL), init)),
    services,
    plans,
    storage,
    auth: calls,
  };
}

/** A document the standalone validator accepts. */
export function html(body = "<p>hello</p>"): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

export function upload(body: string): RequestInit {
  return { method: "PUT", headers: { "content-type": "text/html" }, body };
}
