import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";

/**
 * Which wiring the entry point chose. Exported by both
 * src/runtime/cloudflare.ts and src/runtime/node.ts.
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
  /**
   * Throws if the backing store is unreachable.
   *
   * `signal` is aborted when the health probe gives up. A driver whose client
   * can carry it MUST pass it down: `/healthz` is unauthenticated, so a
   * blackholed endpoint that keeps its socket after the deadline is a socket
   * and a pool client per call. Ignoring it is allowed - not every client API
   * takes one - and costs only that release.
   */
  probe(signal?: AbortSignal): Promise<void>;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  probe(signal?: AbortSignal): Promise<void>;
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

export type PlanVisibility = "public" | "private";

/**
 * What the read gate needs, in one row.
 *
 * `shareCodeHash` is a digest, and it is here to be compared against a
 * presented code - `resolvePlanAccess` and the cookie it mints are the only
 * readers. It MUST NOT reach a response body or a log: it is the one value
 * that would let a holder forge the unlock cookie for this plan.
 */
export interface PlanAccessRow {
  ownerId: string;
  visibility: PlanVisibility;
  shareCodeHash: string | null;
}

/**
 * Why `grantByHandle` reports three outcomes: the caller renders a different
 * message for an unknown handle than for a plan it does not own.
 */
export type GrantOutcome = "granted" | "no-plan" | "no-user";

export interface PlanRow {
  id: string;
  /** Owner-facing text, null until one is set. */
  label: string | null;
  size: number;
  createdAt: Date;
  visibility: PlanVisibility;
  /** Whether a share code is set. The hash itself never leaves the repo. */
  hasShareCode: boolean;
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
      visibility: PlanVisibility;
      shareCodeHash: string | null;
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
  /** One read for the gate. Null means no such plan. */
  findAccess(id: string): Promise<PlanAccessRow | null>;
  hasGrant(planId: string, userId: string): Promise<boolean>;
  /**
   * False means not found or not owned by `userId`.
   *
   * Neither visibility leaves a code on a public plan. `public` clears any
   * hash outright; `private` clears one only when the row was public, which
   * catches the pair `insert` still accepts and rows written before this rule.
   * A plan that was already private keeps its code - that is the code-shared
   * state itself, and `DELETE /share-code` is how it is dropped. Unlock
   * cookies are bound to the digest, so they die with it. Grants are untouched.
   */
  setVisibility(
    id: string,
    userId: string,
    visibility: PlanVisibility,
  ): Promise<boolean>;
  /**
   * `hash` null clears the code. False means not found or not owned.
   *
   * Setting a hash additionally requires the plan to be private, which is what
   * holds the invariant that a public plan never carries one. Clearing is
   * always allowed, so a public row can still be tidied. False therefore also
   * means "the plan is public"; the caller re-reads to tell them apart.
   */
  setShareCodeHash(
    id: string,
    userId: string,
    hash: string | null,
  ): Promise<boolean>;
  /** Handles of every granted account. Null means not found or not owned. */
  listGrantHandles(planId: string, ownerId: string): Promise<string[] | null>;
  grantByHandle(
    planId: string,
    ownerId: string,
    handle: string,
  ): Promise<GrantOutcome>;
  /** False means not found, not owned, or the handle held no grant. */
  revokeByHandle(
    planId: string,
    ownerId: string,
    handle: string,
  ): Promise<boolean>;
}

/**
 * Rows fetched per `listByUser` call. Fixed, so it cannot drift with the
 * quota - see the note there.
 */
export const PLAN_PAGE_SIZE = 500;

/**
 * The admission gate for account deletion.
 *
 * Deleting an account removes objects the database does not know about, so it
 * sweeps them and then lets the foreign key take the rows. Marking the account
 * first is what stops an upload slipping between the sweep and the cascade and
 * leaving an object nothing owns.
 */
export interface AccountClosingRepo {
  /** Idempotent: re-running a failed deletion must not fail on the marker. */
  open(userId: string): Promise<void>;
  isOpen(userId: string): Promise<boolean>;
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
  /**
   * Share-code redemptions, bucketed by client address. Its own table: the key
   * is not a user id, so it cannot cascade and prunes itself instead.
   */
  unlockRateLimits: RateLimitRepo;
  accountClosing: AccountClosingRepo;
  probe(signal?: AbortSignal): Promise<void>;
}

export interface Services {
  config: Config;
  auth: AppAuth;
  logger: Logger;
  storage: PlanStorage;
  kv: KvStore;
  db: Db;
}
