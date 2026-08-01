import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Logger } from "../log.ts";
import type { Db } from "../services/types.ts";
import { type PgAuthHandle, pgDialect, pgSchema } from "./pg-shared.ts";
import { createDialectRepos } from "./repos.ts";

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
 * stops answering is bounded only from this end.
 *
 * Set past the server's rather than equal to it, on purpose. Equal, the two
 * race, and which fires is a coin toss - but only the server's has a defined
 * outcome: `57014` means the statement did not run and its transaction is
 * aborted, which is what lets `isTimeout` promise a safe retry. The client's
 * deadline says only that no answer arrived, leaving whatever the server is
 * doing unknown. Letting the server win means the client's deadline fires
 * only when the server has genuinely stopped answering, which is a fault
 * rather than a queue and is reported as one.
 *
 * Both bounds are what keeps the plan claim from eating the pool. Concurrent
 * uploads by one account queue on the advisory lock `pgDialect.claim` takes,
 * and a waiter holds its connection for as long as it waits - so `POOL_MAX`
 * claims for the same account is the whole pool, blocked. `statement_timeout`
 * is the ceiling on how long that can last: the lock wait is a statement, so a
 * queue that deep ends in an error rather than a hang, and the connection goes
 * back. Uploads are already rate limited per account, which is what makes the
 * depth a bounded worry rather than an open one.
 *
 * Such a timeout leaves the transaction rolled back and nothing claimed, so
 * the upload fails whole rather than partly. `pgClaim` names it as
 * `DatabaseUnavailable` and src/http/create-plan.ts answers 503 with a
 * `retry-after`: the request was fine and the deployment was busy, which is a
 * different thing to tell a caller than "something broke".
 */
const POOL_MAX = 10;
const CONNECTION_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 15_000;
/** Past `statement_timeout`, so the deadline with defined semantics wins. */
const QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 1_000;

const ABANDONED = "health probe abandoned; connection discarded";

/**
 * A pool client, or the caller's reason for having stopped waiting.
 *
 * Raced, because waiting for a free client is bounded by
 * `connectionTimeoutMillis` and that outlasts the probe's deadline. The
 * acquisition itself is not cancelled - `pool.connect` takes no signal - so a
 * client can still turn up afterwards, and is destroyed rather than parked.
 */
async function acquire(
  pool: pg.Pool,
  signal?: AbortSignal,
): Promise<pg.PoolClient> {
  const pending = pool.connect();
  if (signal === undefined) return await pending;
  /*
   * Named and removed rather than left to `once: true`. The signal belongs to
   * the caller and outlives this race - a listener left on it holds this
   * closure, and its rejected promise, for as long as the caller keeps the
   * signal around.
   */
  let onAbort = (): void => {};
  const abandoned = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, abandoned]);
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
  const client = await acquire(pool, signal);
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

export function createPostgresDb(
  connectionString: string,
  logger: Pick<Logger, "warn">,
): Db & PgAuthHandle {
  const pool = new pg.Pool({
    connectionString,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });

  /*
   * Required, not diagnostic. `pg` emits this when a client sitting idle in
   * the pool fails - Postgres restarting, a network drop, an idle timeout on a
   * proxy in between - and `error` is the one event name Node throws for when
   * nothing is listening. Without this, a database blip takes the process down
   * rather than the connection: the pool discards the client and the next
   * request opens another, which is a recovery nobody is present for if the
   * default handler already ran.
   */
  pool.on("error", (cause) => {
    logger.warn({ err: cause }, "idle postgres client failed");
  });

  const db = drizzle(pool, { schema: pgSchema });
  const dialect = pgDialect(db);
  return {
    adapter: db,
    provider: "pg",
    ...createDialectRepos(dialect, logger),
    probe: (signal) => probeOnce(pool, signal),
  };
}
