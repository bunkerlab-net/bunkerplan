import { and, eq, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RateLimitRepo, RateLimitResult } from "../services/types.ts";
import type { PgSchema } from "./pg-shared.ts";
import { retryAfterSeconds, sometimes } from "./rate-limit-window.ts";
import { unlockRateLimit, uploadRateLimit } from "./schema/rate-limit.pg.ts";

/**
 * Either counter table. See the sqlite twin for why one implementation serves
 * both.
 */
export type PgRateLimitTable = typeof uploadRateLimit | typeof unlockRateLimit;

/**
 * Gives one count back, for a reservation the caller decided not to keep.
 *
 * Its own function so the factory below stays one statement per method. See the
 * sqlite twin, whose reasoning this mirrors exactly.
 */
async function refundOne(
  db: NodePgDatabase<PgSchema>,
  t: PgRateLimitTable,
  key: string,
  windowStart: number,
): Promise<void> {
  await db
    .update(t)
    // Floored, and matched on the exact window that charged it. A request whose
    // window rolled while it was in flight has nothing to give back: that count
    // went with the window, and this row now holds somebody else's fresh budget.
    .set({ count: sql`greatest(${t.count} - 1, 0)` })
    .where(and(eq(t.key, key), eq(t.windowStart, windowStart)));
}

/**
 * Takes one count, and says whether the caller may proceed.
 *
 * Its own function so the factory below stays one statement per method, the
 * same shape as the sqlite twin - which is what lets the two be read side by
 * side when a difference between them is suspected.
 */
async function consumeOne(
  db: NodePgDatabase<PgSchema>,
  t: PgRateLimitTable,
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

/** See src/db/rate-limits.sqlite.ts for why this is a single statement. */
export function createPgRateLimitRepo(
  db: NodePgDatabase<PgSchema>,
  t: PgRateLimitTable = uploadRateLimit,
): RateLimitRepo {
  return {
    consume: (key, max, windowSeconds) =>
      consumeOne(db, t, key, max, windowSeconds),
    refund: (key, windowStart) => refundOne(db, t, key, windowStart),
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

    // No sweep here: a refund follows a reservation this repo already swept for,
    // and sweeping again would only add a write to the path that gives one back.
    refund: counter.refund,
  };
}
