import { and, eq, lte, sql } from "drizzle-orm";
import type { RateLimitRepo, RateLimitResult } from "../services/types.ts";
import { retryAfterSeconds, sometimes } from "./rate-limit-window.ts";
import {
  unlockRateLimit,
  uploadRateLimit,
} from "./schema/rate-limit.sqlite.ts";
import type { SqliteDb } from "./sqlite-shared.ts";

/**
 * Either counter table. They differ only in name and in whether the key
 * cascades from `user`, neither of which the statements below can see.
 */
export type RateLimitTable = typeof uploadRateLimit | typeof unlockRateLimit;

/**
 * Gives one count back, for a reservation the caller decided not to keep.
 *
 * Matched on the exact window that charged it rather than on the window merely
 * being open. A request whose window rolled while it was in flight has nothing
 * to give back: that count went with the window, and the row now holds a fresh
 * budget somebody else opened - taking one off it would charge them for a
 * request they never made.
 *
 * `max(x, 0)` rather than Postgres's `greatest`: the two dialects spell the
 * floor differently, which is why each writes its own statement here.
 */
async function refundOne(
  db: SqliteDb,
  t: RateLimitTable,
  key: string,
  windowStart: number,
): Promise<void> {
  // Floored, so a repeat cannot drive the count negative - but not idempotent:
  // two refunds of one reservation give back two counts. The caller reaches
  // this once per reservation, on the path that took one.
  await db
    .update(t)
    .set({ count: sql`max(${t.count} - 1, 0)` })
    .where(and(eq(t.key, key), eq(t.windowStart, windowStart)));
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
  db: SqliteDb,
  t: RateLimitTable,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  const cutoff = now - windowMs;

  const consumed = await db
    .insert(t)
    .values({ key, count: 1, windowStart: now })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        count: sql`case when ${t.windowStart} <= ${cutoff} then 1 else ${t.count} + 1 end`,
        windowStart: sql`case when ${t.windowStart} <= ${cutoff} then ${now} else ${t.windowStart} end`,
      },
      setWhere: sql`${t.windowStart} <= ${cutoff} or ${t.count} < ${max}`,
    })
    .returning({ windowStart: t.windowStart });

  const row = consumed[0];
  if (row !== undefined) {
    return {
      allowed: true,
      retryAfter: retryAfterSeconds(row.windowStart, now, windowMs),
      // The window this count came out of, so a refund can name it.
      windowStart: row.windowStart,
    };
  }

  // Refused. Re-read only to say how long the caller must wait; if the row has
  // since gone, a whole window is the safe answer.
  const current = await db
    .select({ windowStart: t.windowStart })
    .from(t)
    .where(eq(t.key, key))
    .limit(1);
  const start = current[0]?.windowStart;
  return {
    allowed: false,
    retryAfter:
      start === undefined
        ? windowSeconds
        : retryAfterSeconds(start, now, windowMs),
  };
}

/**
 * One implementation for both counter tables: the decision is identical, only
 * the bucket differs. `unlock_rate_limit` is structurally the same table
 * without the user cascade.
 */
export function createSqliteRateLimitRepo(
  db: SqliteDb,
  t: RateLimitTable = uploadRateLimit,
): RateLimitRepo {
  return {
    consume: (key, max, windowSeconds) =>
      consumeOne(db, t, key, max, windowSeconds),
    refund: (key, windowStart) => refundOne(db, t, key, windowStart),
  };
}

/**
 * The unlock bucket, which prunes itself.
 *
 * `upload_rate_limit` needs no sweep: its key cascades from `user`, so a
 * counter goes when its account does. This table's key is a digest of a client
 * address, with nothing to cascade from, so an unauthenticated caller could
 * otherwise plant a row per address for good. A closed window can only ever be
 * reset, never refused, so deleting one never changes a decision.
 *
 * `shouldSweep` is injected so the pruning test can ask for one instead of
 * rolling dice until it gets one.
 */
export function createSqliteUnlockRateLimitRepo(
  db: SqliteDb,
  shouldSweep: () => boolean = sometimes,
): RateLimitRepo {
  const counter = createSqliteRateLimitRepo(db, unlockRateLimit);
  return {
    async consume(key, max, windowSeconds) {
      if (shouldSweep()) {
        await db
          .delete(unlockRateLimit)
          .where(
            lte(unlockRateLimit.windowStart, Date.now() - windowSeconds * 1000),
          );
      }
      return await counter.consume(key, max, windowSeconds);
    },

    // No sweep here: a refund follows a reservation this repo already swept for,
    // and sweeping again would only add a write to the path giving one back.
    refund: counter.refund,
  };
}
