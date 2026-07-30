import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "../services/types.ts";
import { createPgAccountClosingRepo } from "./account-closing.pg.ts";
import { pgSchema } from "./pg-shared.ts";
import { createPgPlanRepo } from "./plans.pg.ts";
import {
  createPgRateLimitRepo,
  createPgUnlockRateLimitRepo,
} from "./rate-limits.pg.ts";

/**
 * Postgres always enforces foreign keys, so the ON DELETE CASCADE constraints
 * are live. `pg` is Node-only - this module MUST NOT be reachable from
 * src/runtime/cloudflare.ts.
 *
 * The pool is bounded on purpose. `pg` defaults `connectionTimeoutMillis` to
 * `0`, meaning a request that cannot get a client waits forever, so a slow or
 * unreachable server turns into an unbounded pile of held requests rather than
 * errors. Failing after a few seconds lets a request return 5xx and free
 * itself. `statement_timeout` is the matching server-side bound: without it a
 * single pathological query holds its connection for as long as it likes.
 *
 * `query_timeout` is the client-side half of that. `statement_timeout` needs a
 * server well enough to enforce it; one that accepts a connection and then
 * stops answering is bounded only from this end. Set to the same value, so the
 * two agree on how long a query may take rather than racing each other.
 */
const POOL_MAX = 10;
const CONNECTION_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 15_000;

const ABANDONED = "health probe abandoned; connection discarded";

/**
 * Asks the database one question, bounded by the caller's deadline rather than
 * the pool's.
 *
 * `PROBE_TIMEOUT_MS` is shorter than `query_timeout`, so an abandoned probe
 * must not park its client: releasing with an error destroys the connection,
 * which frees the slot at the abort rather than whenever the server gets
 * around to answering. Not a shorter `statement_timeout` for this one query -
 * as above, that needs a server well enough to enforce it, which is not the
 * case being bounded.
 */
async function probeOnce(pool: pg.Pool, signal?: AbortSignal): Promise<void> {
  // Throwing, not returning: a probe that resolves is a probe that found the
  // database reachable, and an abandoned one established nothing.
  if (signal?.aborted) throw signal.reason;
  /*
   * Raced, because waiting for a free client is bounded by
   * `connectionTimeoutMillis` and that outlasts the probe's deadline. The
   * acquisition itself is not cancelled - `pool.connect` takes no signal - so
   * a client can still turn up afterwards, and is thrown away rather than
   * parked.
   */
  const pending = pool.connect();
  if (signal !== undefined) {
    /*
     * Named and removed rather than left to `once: true`. The signal belongs
     * to the caller and outlives this race - a listener left on it holds this
     * closure, and its rejected promise, for as long as the caller keeps the
     * signal around.
     */
    let onAbort = (): void => {};
    const abandoned = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([pending, abandoned]);
    } catch (cause) {
      void pending.then(
        (late) => late.release(new Error(ABANDONED)),
        () => {},
      );
      throw cause;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  const client = await pending;
  let released = false;
  /*
   * An argument destroys the connection instead of parking it, which is what
   * `pool.query` did before this took the client itself: a query that failed
   * can leave the protocol mid-message, so the connection is not fit to hand
   * out again.
   */
  const release = (broken?: Error) => {
    if (released) return;
    released = true;
    client.release(broken);
  };
  const abandon = () => release(new Error(ABANDONED));
  if (signal?.aborted) {
    abandon();
    throw signal.reason;
  }
  signal?.addEventListener("abort", abandon, { once: true });
  try {
    await client.query("select 1");
  } catch (cause) {
    release(cause instanceof Error ? cause : new Error(String(cause)));
    /*
     * The caller's reason when the caller is why this failed. Destroying the
     * connection is what makes the in-flight query reject, so an abandoned
     * probe would otherwise report the driver's socket error - a different
     * answer from the two abort paths above, for the same event.
     */
    if (signal?.aborted) throw signal.reason;
    throw cause;
  } finally {
    signal?.removeEventListener("abort", abandon);
    release();
  }
}

export function createPostgresDb(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
  });
  const db = drizzle(pool, { schema: pgSchema });
  return {
    adapter: db,
    provider: "pg",
    plans: createPgPlanRepo(db),
    uploadRateLimits: createPgRateLimitRepo(db),
    unlockRateLimits: createPgUnlockRateLimitRepo(db),
    accountClosing: createPgAccountClosingRepo(db),
    probe: (signal) => probeOnce(pool, signal),
  };
}
