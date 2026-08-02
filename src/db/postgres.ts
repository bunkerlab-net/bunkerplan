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
 * race and which fires is a coin toss - and only the server's can be
 * classified at all. `57014` is the server naming what it did, a code that
 * means something definite at a call site that knows which statement it
 * wrapped; the client's deadline reports only that no answer arrived, which is
 * uninterpretable wherever it is caught. Letting the server win means the
 * client's deadline fires only when the server has genuinely stopped
 * answering, which is a fault rather than a queue and is reported as one.
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
 * A cancellation caught around that wait is the retryable one, and only that
 * one: `pgClaim` names it `DatabaseUnavailable` from inside the transaction
 * callback - before any write, so nothing was claimed - and
 * src/http/create-plan.ts answers 503 with a `retry-after`. A `57014` seen
 * anywhere else may have landed on the `COMMIT`, where the outcome is unknown,
 * and stays a fault. See `isStatementCancelled` in src/db/unavailable.ts for
 * why the position decides it rather than the code.
 */
const POOL_MAX = 10;
const CONNECTION_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 15_000;
/** Past `statement_timeout`, so the deadline with defined semantics wins. */
const QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 1_000;
/*
 * The claim's own `lock_timeout` belongs in this list and cannot live here.
 * It is `LOCK_TIMEOUT_MS` in src/db/pg-shared.ts, set on the transaction that
 * takes the advisory lock, and it is deliberately well under
 * `STATEMENT_TIMEOUT_MS`: both deadlines can end the same wait, but only the
 * shorter one says what ended it. `55P03` means contention and nothing
 * written - a 503 and a retry - where `57014` could have landed anywhere and
 * stays a fault.
 *
 * Declaring it beside these would make src/db/pg-shared.ts import this module,
 * which already imports it: a cycle, and one `bunx madge --circular` fails the
 * build over. It sits with the statement that sets it instead.
 */

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
 *
 * Exported for the pool it takes, not for callers: `createPostgresDb` builds
 * the only real one, and the abort windows below are races between that pool
 * and the caller's signal. A test that cannot hand this a pool of its own can
 * only reach them by timing, which is a flake rather than a test.
 */
export async function probeOnce(
  pool: pg.Pool,
  signal?: AbortSignal,
): Promise<void> {
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
