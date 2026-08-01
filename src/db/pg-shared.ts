import { type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Dialect, SqlExecutor } from "./dialect.ts";
import * as accountClosingSchema from "./schema/account-closing.pg.ts";
import * as authSchema from "./schema/auth.pg.ts";
import * as planSchema from "./schema/plan.pg.ts";
import * as rateLimitSchema from "./schema/rate-limit.pg.ts";

export const pgSchema = {
  ...authSchema,
  ...planSchema,
  ...rateLimitSchema,
  ...accountClosingSchema,
};

export type PgSchema = typeof pgSchema;

export type PgDb = NodePgDatabase<PgSchema>;

/**
 * The two calls every Postgres statement goes through, over whichever handle
 * issues it: the pool for an ordinary read, the transaction inside `claim`.
 *
 * node-postgres types the rows through drizzle's `Assume<T, QueryResultRow>`;
 * the cast only removes that wrapper, `T` already is the row shape the caller
 * declared.
 */
function pgExecutor(handle: Pick<PgDb, "execute">): SqlExecutor {
  return {
    async rows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
      return (await handle.execute(query)).rows as T[];
    },
    async run(query: SQL): Promise<void> {
      await handle.execute(query);
    },
  };
}

/**
 * The Postgres half of the repository seam - see src/db/dialect.ts for what
 * each member is for.
 */
export function pgDialect(db: PgDb): Dialect {
  const executor = pgExecutor(db);
  return {
    ...executor,
    tables: {
      plan: planSchema.plan,
      planGrant: planSchema.planGrant,
      user: authSchema.user,
      accountClosing: accountClosingSchema.accountClosing,
      uploadRateLimit: rateLimitSchema.uploadRateLimit,
      unlockRateLimit: rateLimitSchema.unlockRateLimit,
    },

    // Postgres reads the count from its snapshot, so unlike SQLite - which
    // serialises writers for us - two concurrent claims at `maxPlans - 1` would
    // both see room and both write. The advisory lock makes count-and-claim one
    // critical section per account, and it is released with the transaction
    // whichever way it ends. The body reads and writes through the transaction,
    // which is the only reason the executor is handed to it.
    claim: (userId, body) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${userId})::bigint)`,
        );
        return await body(pgExecutor(tx));
      }),

    // Drizzle asks node-postgres to leave timestamps as the strings Postgres
    // sent, so the column's own mapper is what reads one - which is also what
    // keeps a `timestamp` column without a zone being read as UTC rather than
    // as the server's local time. The cast only names what that mapper
    // returns, which the column's declared type already fixes.
    createdAt: (value) =>
      planSchema.plan.createdAt.mapFromDriverValue(value) as Date,

    floor: (expr) => sql`greatest(${expr}, 0)`,
  };
}

/**
 * The `Db` fields `src/auth/instance.ts` hands to `drizzleAdapter`, narrowed to
 * the drizzle instance this dialect actually holds. See `SqliteAuthHandle` in
 * src/db/sqlite-shared.ts for why the pairing is a type rather than a comment.
 */
export type PgAuthHandle = { adapter: PgDb; provider: "pg" };
