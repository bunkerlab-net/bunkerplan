import { type SQLWrapper, sql } from "drizzle-orm";
import type { Logger } from "../log.ts";
import type { RateLimitRepo, RateLimitResult } from "../services/types.ts";
import type { Dialect } from "./dialect.ts";
import { retryAfterSeconds, sometimes } from "./rate-limit-window.ts";

/**
 * Gives one count back, for a reservation the caller decided not to keep.
 *
 * Matched on the exact window that charged it rather than on the window merely
 * being open. A request whose window rolled while it was in flight has nothing
 * to give back: that count went with the window, and the row now holds a fresh
 * budget somebody else opened - taking one off it would charge them for a
 * request they never made.
 *
 * The floor is the one thing the two engines spell differently - `max` against
 * `greatest` - which `dialect.floor` names once.
 */
async function refundOne(
  dialect: Dialect,
  counter: SQLWrapper,
  key: string,
  windowStart: number,
): Promise<void> {
  // Floored, so a repeat cannot drive the count negative - but not idempotent:
  // two refunds of one reservation give back two counts. The caller reaches
  // this once per reservation, on the path that took one.
  await dialect.run(sql`
    update ${counter}
    set "count" = ${dialect.floor(sql`"count" - 1`)}
    where "key" = ${key} and window_start = ${windowStart}
  `);
}

/**
 * Takes one count against `key`, and says whether it was allowed.
 *
 * One statement is the whole decision. The insert claims a brand new key;
 * otherwise the conflict branch rolls the window over or increments, and its
 * WHERE refuses the row once the count has reached the limit. A refusal updates
 * nothing and so returns nothing, which is how the caller tells the two apart.
 *
 * It has to be one statement. Reading the count and then writing it lets two
 * concurrent callers both see the same value and both pass, and a separate
 * "insert if missing" step would wrongly refuse the loser of a race between two
 * first requests for the same key.
 */
async function consumeOne(
  dialect: Dialect,
  counter: SQLWrapper,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const cutoff = now - windowMs;

  // A bucket that allows nothing refuses without touching the table. The
  // insert below claims a brand new key unconditionally - there is no conflict
  // for `count < max` to be tested against - so a `max` of zero would let the
  // first request per key through the very limit forbidding it.
  if (max < 1) return { allowed: false, retryAfter: windowSeconds };

  // `window_start` is epoch milliseconds, reported as a number by SQLite and as
  // a string by Postgres, whose column is a `bigint` - hence the conversion on
  // every read of it here.
  const consumed = await dialect.rows<{ windowStart: number | string }>(sql`
    insert into ${counter} ("key", "count", window_start)
    values (${key}, 1, ${now})
    on conflict ("key") do update set
      "count" = case when ${counter}.window_start <= ${cutoff} then 1
                     else ${counter}."count" + 1 end,
      window_start = case when ${counter}.window_start <= ${cutoff} then ${now}
                          else ${counter}.window_start end
    where ${counter}.window_start <= ${cutoff} or ${counter}."count" < ${max}
    returning window_start as "windowStart"
  `);

  const row = consumed[0];
  if (row !== undefined) {
    const windowStart = Number(row.windowStart);
    return {
      allowed: true,
      retryAfter: retryAfterSeconds(windowStart, now, windowMs),
      // The window this count came out of, so a refund can name it.
      windowStart,
    };
  }

  // Refused. Re-read only to say how long the caller must wait; if the row has
  // since gone, a whole window is the safe answer.
  const current = await dialect.rows<{ windowStart: number | string }>(sql`
    select window_start as "windowStart" from ${counter}
    where "key" = ${key}
    limit 1
  `);
  const start = current[0]?.windowStart;
  return {
    allowed: false,
    retryAfter:
      start === undefined
        ? windowSeconds
        : retryAfterSeconds(Number(start), now, windowMs),
  };
}

/**
 * One implementation for both counter tables: the decision is identical, only
 * the bucket differs. `unlock_rate_limit` is structurally the same table
 * without the user cascade.
 *
 * `counter` is required rather than defaulted to the upload bucket: a factory
 * that picks a table when the caller says nothing would let a new bucket share
 * the upload counter silently, and the two decide different limits.
 */
export function createRateLimitRepo(
  dialect: Dialect,
  counter: SQLWrapper,
): RateLimitRepo {
  return {
    consume: (key, max, windowSeconds) =>
      consumeOne(dialect, counter, key, max, windowSeconds),
    refund: (key, windowStart) => refundOne(dialect, counter, key, windowStart),
  };
}

/**
 * Closed windows one sweep will remove.
 *
 * The prune runs on the request path, and this table is the one an anonymous
 * caller can grow: its key is a digest of a client address, so a flood from
 * many addresses leaves a row each. Unbounded, a single redemption that
 * happened to draw the sweep would pay for every row that ever accumulated -
 * a statement long enough to trip the Postgres `statement_timeout` or a D1
 * query limit, and a sweep that throws is a sweep that never gets further,
 * so the backlog it choked on would grow forever.
 *
 * Bounded, one redemption pays for at most this many deletions and the
 * backlog drains over the sweeps that follow. Nothing waits on it: a closed
 * window can only ever be reset, never refused, so a row left for the next
 * sweep changes no decision.
 */
const UNLOCK_SWEEP_BATCH = 500;

/** What the pruning tests inject; a deployment takes both defaults. */
export interface UnlockSweepOptions {
  /** Injected so a test can ask for a sweep instead of rolling dice for one. */
  shouldSweep?: () => boolean;
  batch?: number;
}

/**
 * The unlock bucket, which prunes itself.
 *
 * `upload_rate_limit` needs no sweep: its key cascades from `user`, so a
 * counter goes when its account does. This table's key is a digest of a client
 * address, with nothing to cascade from, so an unauthenticated caller could
 * otherwise plant a row per address for good.
 */
export function createUnlockRateLimitRepo(
  dialect: Dialect,
  logger: Pick<Logger, "warn">,
  options: UnlockSweepOptions = {},
): RateLimitRepo {
  const { shouldSweep = sometimes, batch = UNLOCK_SWEEP_BATCH } = options;
  const unlock = dialect.tables.unlockRateLimit;
  const counter = createRateLimitRepo(dialect, unlock);
  return {
    async consume(key, max, windowSeconds) {
      // Housekeeping, and never the decision. A prune that fails - lock
      // contention on SQLite, a blip on the way to Postgres - must not refuse
      // a redemption the counter would have allowed, and the next sweep tries
      // again. A failure that is really the database being gone surfaces on
      // the consume below, which is the call that has to be right.
      if (shouldSweep()) {
        try {
          // `key in (select ... limit)` rather than `delete ... limit`, which
          // Postgres does not have at all. Both engines take this form, and
          // `key` is the primary key, so the inner select reads the
          // `window_start` index and the delete matches on the key.
          //
          // `order by window_start` takes the oldest first, so a backlog
          // drains in the order it accumulated rather than the sweep circling
          // whatever the planner happened to return.
          await dialect.run(sql`
            delete from ${unlock}
            where "key" in (
              select "key" from ${unlock}
              where window_start <= ${Date.now() - windowSeconds * 1000}
              order by window_start
              limit ${batch}
            )
          `);
        } catch (cause) {
          logger.warn({ err: cause }, "unlock rate-limit sweep failed");
        }
      }
      return await counter.consume(key, max, windowSeconds);
    },

    // No sweep here: a refund follows a reservation this repo already swept for,
    // and sweeping again would only add a write to the path giving one back.
    refund: counter.refund,
  };
}
