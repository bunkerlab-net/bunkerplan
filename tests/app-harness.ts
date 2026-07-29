import { pino } from "pino";
import { type AppDeps, createApp } from "../src/app.ts";
import type { AppAuth } from "../src/auth/instance.ts";
import type { Config } from "../src/config.ts";
import type { AssetManifest } from "../src/server/assets.ts";
import type {
  AccountClosingRepo,
  Db,
  KvStore,
  PlanAccessRow,
  PlanInsert,
  PlanObject,
  PlanRepo,
  PlanRow,
  PlanStorage,
  PlanVisibility,
  RateLimitRepo,
  RuntimeTarget,
  Services,
} from "../src/services/types.ts";

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
 * middleware; only the backends are fakes, and each one is a plain object a
 * test can make misbehave.
 */

export const OWNER = "user-owner";
export const GRANTEE = "user-grantee";
export const STRANGER = "user-stranger";
export const PLAN_ID = "abcdefgh12345678";

export const PUBLIC_BASE_URL = "https://plans.example.test";

/**
 * The header the unlock throttle identifies a caller by. Configuration refuses
 * to load without one, so a request that omits it is refused rather than
 * counted - which is a case worth reaching, so it is named here.
 */
export const CLIENT_IP_HEADER = "x-forwarded-for";
export const CLIENT_IP = "203.0.113.7";

export const CONFIG = {
  publicBaseUrl: PUBLIC_BASE_URL,
  secret: "app-harness-secret-0123456789abcdef",
  maxUploadBytes: 2 * 1024 * 1024,
  planIdLength: 16,
  shareCodeLength: 16,
  maxPlansPerUser: 10,
  uploadRateMax: 100,
  uploadRateWindowSec: 60,
  unlockRateMax: 100,
  unlockRateWindowSec: 60,
  clientIpHeader: CLIENT_IP_HEADER,
} as unknown as Config;

export const ASSETS: AssetManifest = {
  script: "/assets/entry-deadbeef.js",
  stylesheet: "/assets/entry-deadbeef.css",
};

/** Silent: these suites assert on responses, not on output. */
export const logger = pino({ level: "silent" });

export interface AuthCalls {
  sessions: number;
  keys: number;
  handled: number;
}

/**
 * Only the endpoints the app touches. `AppAuth` is Better Auth's fully
 * inferred plugin-aware type - hundreds of endpoints that cannot be spelled
 * out here - so this is where a cast is the honest option, exactly as
 * tests/plan-access.test.ts does it.
 */
export function fakeAuth(
  over: {
    sessionUser?: string | null;
    keyUser?: string | null;
    handler?: (request: Request) => Promise<Response>;
  } = {},
): { auth: AppAuth; calls: AuthCalls } {
  const calls: AuthCalls = { sessions: 0, keys: 0, handled: 0 };
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
  const handler = async (request: Request): Promise<Response> => {
    calls.handled += 1;
    return over.handler === undefined
      ? new Response("better-auth", { status: 200 })
      : await over.handler(request);
  };
  return { auth: { api, handler } as unknown as AppAuth, calls };
}

export interface StoredPlan {
  id: string;
  userId: string;
  label: string | null;
  size: number;
  visibility: PlanVisibility;
  shareCodeHash: string | null;
  createdAt: Date;
  grants: string[];
}

export function storedPlan(over: Partial<StoredPlan> = {}): StoredPlan {
  return {
    id: PLAN_ID,
    userId: OWNER,
    label: null,
    size: 64,
    visibility: "private",
    shareCodeHash: null,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    grants: [],
    ...over,
  };
}

/**
 * A `PlanRepo` over a Map.
 *
 * Real enough that ownership, the quota, and the "a public plan never carries
 * a code" invariant behave the way the SQL does - a handler that skips an
 * ownership check fails here, rather than passing against a stub that answers
 * yes to everything.
 */
export function memoryPlans(
  seed: StoredPlan[] = [],
  handles: Record<string, string> = {},
): PlanRepo & { rows: Map<string, StoredPlan> } {
  const rows = new Map(seed.map((row) => [row.id, row]));
  const owned = (id: string, userId: string): StoredPlan | undefined => {
    const row = rows.get(id);
    return row?.userId === userId ? row : undefined;
  };
  const handleOf = (userId: string): string =>
    Object.entries(handles).find(([, id]) => id === userId)?.[0] ?? userId;

  return {
    rows,
    /*
     * `createdAt` is stamped here, not taken from `row`: `PlanRepo.insert` in
     * src/services/types.ts declares the row as `{ id, userId, label, size,
     * visibility, shareCodeHash }` with no `createdAt` in it, because both real
     * drivers let the column default in the database. A caller cannot pass one
     * through this signature, so there is nothing here to preserve.
     */
    insert: async (row, maxPlans): Promise<PlanInsert> => {
      if (rows.has(row.id)) return "duplicate";
      const held = [...rows.values()].filter(
        (item) => item.userId === row.userId,
      ).length;
      if (held >= maxPlans) return "quota";
      rows.set(row.id, { ...storedPlan(), ...row, createdAt: new Date() });
      return "created";
    },
    /*
     * `createdAt` descending and nothing else, because that is the whole of the
     * `orderBy` both drivers issue (src/db/plans.pg.ts and plans.sqlite.ts).
     *
     * Two inserts inside one millisecond therefore tie, and neither the SQL nor
     * this says which comes back first. Deliberately not broken by insertion
     * order here: a fake that promises an ordering production does not have lets
     * a test depend on it and pass, which is the failure a fake is supposed to
     * prevent. Suites that care seed distinct timestamps.
     */
    listByUser: async (userId, limit): Promise<PlanRow[]> =>
      [...rows.values()]
        .filter((row) => row.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          label: row.label,
          size: row.size,
          createdAt: row.createdAt,
          visibility: row.visibility,
          hasShareCode: row.shareCodeHash !== null,
        })),
    findOwner: async (id) => rows.get(id)?.userId ?? null,
    relabel: async (id, userId, label) => {
      const row = owned(id, userId);
      if (row === undefined) return false;
      row.label = label;
      return true;
    },
    resize: async (id, userId, size) => {
      const row = owned(id, userId);
      if (row === undefined) return false;
      row.size = size;
      return true;
    },
    deleteOwned: async (id, userId) => {
      if (owned(id, userId) === undefined) return false;
      rows.delete(id);
      return true;
    },
    findAccess: async (id): Promise<PlanAccessRow | null> => {
      const row = rows.get(id);
      return row === undefined
        ? null
        : {
            ownerId: row.userId,
            visibility: row.visibility,
            shareCodeHash: row.shareCodeHash,
          };
    },
    hasGrant: async (planId, userId) =>
      rows.get(planId)?.grants.includes(userId) ?? false,
    setVisibility: async (id, userId, visibility) => {
      const row = owned(id, userId);
      if (row === undefined) return false;
      // Neither visibility leaves a code on a public plan.
      if (visibility === "public" || row.visibility === "public") {
        row.shareCodeHash = null;
      }
      row.visibility = visibility;
      return true;
    },
    setShareCodeHash: async (id, userId, hash) => {
      const row = owned(id, userId);
      if (row === undefined) return false;
      // Setting one requires the plan to be private; clearing is always
      // allowed, so a public row can still be tidied.
      if (hash !== null && row.visibility === "public") return false;
      row.shareCodeHash = hash;
      return true;
    },
    listGrantHandles: async (planId, ownerId) =>
      owned(planId, ownerId)?.grants.map(handleOf) ?? null,
    grantByHandle: async (planId, ownerId, handle) => {
      const row = owned(planId, ownerId);
      if (row === undefined) return "no-plan";
      const userId = handles[handle];
      if (userId === undefined) return "no-user";
      if (!row.grants.includes(userId)) row.grants.push(userId);
      return "granted";
    },
    revokeByHandle: async (planId, ownerId, handle) => {
      const row = owned(planId, ownerId);
      const userId = handles[handle];
      if (row === undefined || userId === undefined) return false;
      const at = row.grants.indexOf(userId);
      if (at === -1) return false;
      row.grants.splice(at, 1);
      return true;
    },
  };
}

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
      objects.set(id, new Uint8Array(body as Uint8Array));
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
  consume: async () => ({ allowed: true, retryAfter: 0 }),
};

export const closedRateLimits: RateLimitRepo = {
  consume: async () => ({ allowed: false, retryAfter: 30 }),
};

export const openAccounts: AccountClosingRepo = {
  open: async () => {},
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
  deps: AppDeps;
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
    provider: "sqlite",
    plans,
    uploadRateLimits: options.uploadRateLimits ?? openRateLimits,
    unlockRateLimits: options.unlockRateLimits ?? openRateLimits,
    accountClosing: options.accountClosing ?? openAccounts,
    probe: options.probe ?? (async () => {}),
  };
  const services: Services = {
    config: options.config ?? CONFIG,
    auth,
    logger,
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
    deps,
  };
}

/** A document the standalone validator accepts. */
export function html(body = "<p>hello</p>"): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

export function upload(body: string): RequestInit {
  return { method: "PUT", headers: { "content-type": "text/html" }, body };
}
