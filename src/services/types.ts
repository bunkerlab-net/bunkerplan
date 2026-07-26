import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";

/**
 * Which wiring the `#runtime` alias resolved to at build time. Exported by
 * both src/runtime/cloudflare.ts and src/runtime/node.ts.
 */
export type RuntimeTarget = "cloudflare" | "node";

export interface PlanObject {
  body: ReadableStream<Uint8Array>;
  size: number;
  etag: string;
}

/**
 * Addressed by plan id, never by object key: turning an id into a key in the
 * store's own namespace is the driver's job, so every call site speaks ids
 * and only the driver knows the layout.
 */
export interface PlanStorage {
  put(id: string, body: Uint8Array): Promise<void>;
  get(id: string): Promise<PlanObject | null>;
  delete(id: string): Promise<void>;
  /** Throws if the backing store is unreachable. */
  probe(): Promise<void>;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  probe(): Promise<void>;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds remaining in the current window. */
  retryAfter: number;
}

export interface RateLimitRepo {
  /**
   * Counts one request against `key` and says whether it is allowed.
   *
   * The whole decision is one conditional upsert, so concurrent callers
   * cannot each read a stale count and all pass. A caller is allowed when the
   * window has rolled over or the count is still below `max`; anything else
   * matches no row and is refused.
   */
  consume(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}

export interface PlanRow {
  id: string;
  /** Owner-facing text, null until one is set. */
  label: string | null;
  size: number;
  createdAt: Date;
}

/**
 * Why `insert` reports three outcomes rather than a boolean: a refusal has two
 * causes that need opposite handling. A duplicate id is retried with a fresh
 * one; a full account must not be.
 */
export type PlanInsert = "created" | "duplicate" | "quota";

export interface PlanRepo {
  /**
   * Claims an id, refusing once the account already holds `maxPlans`.
   *
   * The ceiling is part of this statement rather than a count the caller
   * checks first, because two concurrent uploads would both read the same
   * count and both pass it.
   */
  insert(
    row: {
      id: string;
      userId: string;
      label: string | null;
      size: number;
    },
    maxPlans: number,
  ): Promise<PlanInsert>;
  /**
   * Most recent first, capped at `limit`. Bounded because the result is
   * serialised whole into one response body.
   *
   * `limit` must NOT be the plan quota. The quota is an operator setting that
   * can be lowered, and rows written under the old value do not disappear when
   * it is - so paging by it would hide them from the dashboard, and worse,
   * would make account deletion sweep only that many objects while the foreign
   * key removed every row, orphaning the remainder permanently. Use
   * `PLAN_PAGE_SIZE` and page until a query comes back short.
   */
  listByUser(userId: string, limit: number): Promise<PlanRow[]>;
  findOwner(id: string): Promise<string | null>;
  /** False means not found or not owned by `userId`. */
  relabel(id: string, userId: string, label: string | null): Promise<boolean>;
  /**
   * Records a replaced document. False means not found or not owned by
   * `userId`, which is what authorises the object write that follows.
   */
  resize(id: string, userId: string, size: number): Promise<boolean>;
  /** False means not found or not owned by `userId`. */
  deleteOwned(id: string, userId: string): Promise<boolean>;
}

/**
 * Rows fetched per `listByUser` call. Fixed, so it cannot drift with the
 * quota - see the note there.
 */
export const PLAN_PAGE_SIZE = 500;

export interface Db {
  /**
   * The value handed to `drizzleAdapter()`. `unknown` because the D1,
   * bun-sqlite, and node-postgres drizzle instances are structurally different
   * types; `src/auth/instance.ts` holds the single cast.
   */
  adapter: unknown;
  /** Drizzle provider name for the adapter. */
  provider: "sqlite" | "pg";
  plans: PlanRepo;
  uploadRateLimits: RateLimitRepo;
  probe(): Promise<void>;
}

export interface Services {
  config: Config;
  auth: AppAuth;
  logger: Logger;
  storage: PlanStorage;
  kv: KvStore;
  db: Db;
}
