import { eq, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RateLimitRepo } from "../services/types.ts";
import type { PgSchema } from "./pg-shared.ts";
import { retryAfterSeconds, sometimes } from "./rate-limit-window.ts";
import { unlockRateLimit, uploadRateLimit } from "./schema/rate-limit.pg.ts";

/**
 * Either counter table. See the sqlite twin for why one implementation serves
 * both.
 */
export type PgRateLimitTable = typeof uploadRateLimit | typeof unlockRateLimit;

/** See src/db/rate-limits.sqlite.ts for why this is a single statement. */
export function createPgRateLimitRepo(
  db: NodePgDatabase<PgSchema>,
  t: PgRateLimitTable = uploadRateLimit,
): RateLimitRepo {
  return {
    async consume(key, max, windowSeconds) {
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
        };
      }

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
 * The unlock bucket. See the sqlite twin for why only this table sweeps, and
 * why it sweeps on a fraction of attempts rather than all of them.
 */
export function createPgUnlockRateLimitRepo(
  db: NodePgDatabase<PgSchema>,
  shouldSweep: () => boolean = sometimes,
): RateLimitRepo {
  const counter = createPgRateLimitRepo(db, unlockRateLimit);
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
  };
}
