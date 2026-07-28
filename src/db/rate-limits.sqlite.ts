import { eq, lte, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { RateLimitRepo } from "../services/types.ts";
import { retryAfterSeconds } from "./rate-limit-window.ts";
import {
  unlockRateLimit,
  uploadRateLimit,
} from "./schema/rate-limit.sqlite.ts";
import type { SqliteSchema } from "./sqlite-shared.ts";

type SqliteDb = BaseSQLiteDatabase<"sync" | "async", unknown, SqliteSchema>;

/**
 * Either counter table. They differ only in name and in whether the key
 * cascades from `user`, neither of which the statements below can see.
 */
export type RateLimitTable = typeof uploadRateLimit | typeof unlockRateLimit;

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
    async consume(key, max, windowSeconds) {
      const windowMs = windowSeconds * 1000;
      const now = Date.now();
      const cutoff = now - windowMs;

      // One statement is the whole decision. The insert claims a brand new
      // key; otherwise the conflict branch rolls the window over or
      // increments, and its WHERE refuses the row once the count has reached
      // the limit. A refusal updates nothing and so returns nothing, which is
      // how the caller tells the two apart.
      //
      // It has to be one statement. Reading the count and then writing it lets
      // two concurrent uploads both see the same value and both pass, and a
      // separate "insert if missing" step would wrongly refuse the loser of a
      // race between two first requests for the same key.
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
        };
      }

      // Refused. Re-read only to say how long the caller must wait; if the row
      // has since gone, a whole window is the safe answer.
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
    },
  };
}

/**
 * The unlock bucket, which prunes itself.
 *
 * `upload_rate_limit` needs no sweep: its key cascades from `user`, so a
 * counter goes when its account does. This table's key is a client address,
 * with nothing to cascade from, so an unauthenticated caller could otherwise
 * plant a row per address for good. A closed window can only ever be reset,
 * never refused, so deleting one never changes a decision.
 */
export function createSqliteUnlockRateLimitRepo(db: SqliteDb): RateLimitRepo {
  const counter = createSqliteRateLimitRepo(db, unlockRateLimit);
  return {
    async consume(key, max, windowSeconds) {
      await db
        .delete(unlockRateLimit)
        .where(
          lte(unlockRateLimit.windowStart, Date.now() - windowSeconds * 1000),
        );
      return await counter.consume(key, max, windowSeconds);
    },
  };
}
