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

export interface PlanRepo {
  /** False means the id already existed - regenerate and retry. */
  insert(row: {
    id: string;
    userId: string;
    label: string | null;
    size: number;
  }): Promise<boolean>;
  listByUser(userId: string): Promise<PlanRow[]>;
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
