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

export interface PlanStorage {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<PlanObject | null>;
  delete(key: string): Promise<void>;
  /** Throws if the backing store is unreachable. */
  probe(): Promise<void>;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Returns null when the backend has no atomic increment (Workers KV). */
  increment(key: string, ttlSeconds: number): Promise<number | null>;
  probe(): Promise<void>;
}

export interface PlanRow {
  id: string;
  size: number;
  createdAt: Date;
}

export interface PlanRepo {
  /** False means the id already existed — regenerate and retry. */
  insert(row: { id: string; userId: string; size: number }): Promise<boolean>;
  listByUser(userId: string): Promise<PlanRow[]>;
  findOwner(id: string): Promise<string | null>;
  /** False means not found or not owned by `userId`. */
  deleteOwned(id: string, userId: string): Promise<boolean>;
}

export interface Db {
  /**
   * The value handed to `drizzleAdapter()`. `unknown` because the D1,
   * bun-sqlite and node-postgres drizzle instances are structurally different
   * types; `src/auth/instance.ts` holds the single cast.
   */
  adapter: unknown;
  /** Drizzle provider name for the adapter. */
  provider: "sqlite" | "pg";
  plans: PlanRepo;
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
