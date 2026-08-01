import { type SQL, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { Dialect, SqlExecutor } from "./dialect.ts";
import * as accountClosingSchema from "./schema/account-closing.sqlite.ts";
import * as authSchema from "./schema/auth.sqlite.ts";
import * as planSchema from "./schema/plan.sqlite.ts";
import * as rateLimitSchema from "./schema/rate-limit.sqlite.ts";

/** The one SQLite schema, shared by the D1 and bun:sqlite drivers. */
export const sqliteSchema = {
  ...authSchema,
  ...planSchema,
  ...rateLimitSchema,
  ...accountClosingSchema,
};

export type SqliteSchema = typeof sqliteSchema;

/**
 * Both the D1 and bun:sqlite drizzle instances extend BaseSQLiteDatabase; the
 * only difference that matters to the repos is sync vs async result kind, and
 * every query builder in them is awaited, which works for both.
 */
export type SqliteDb = BaseSQLiteDatabase<
  "sync" | "async",
  unknown,
  SqliteSchema
>;

/**
 * The SQLite half of the repository seam - see src/db/dialect.ts for what each
 * member is for. One dialect serves both SQLite drivers, because nothing here
 * distinguishes D1 from bun:sqlite.
 */
export function sqliteDialect(db: SqliteDb): Dialect {
  const executor: SqlExecutor = {
    async rows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
      return await db.all<T>(query);
    },
    async run(query: SQL): Promise<void> {
      await db.run(query);
    },
  };
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

    // No critical section: the claim is one statement, and SQLite serialises
    // writers, so count-and-claim cannot be interleaved. Postgres counts
    // against a snapshot and needs the lock its own dialect takes.
    claim: (_userId, body) => body(executor),

    // `created_at` is `integer(..., { mode: "timestamp_ms" })`, so the driver
    // hands back epoch milliseconds and the column's own mapper is what turns
    // them into a `Date` - the cast only names what that mapper returns, which
    // the column's declared type already fixes.
    createdAt: (value) =>
      planSchema.plan.createdAt.mapFromDriverValue(value) as Date,

    floor: (expr) => sql`max(${expr}, 0)`,
  };
}

/**
 * The `Db` fields `src/auth/instance.ts` hands to `drizzleAdapter`, narrowed to
 * the drizzle instance this dialect actually holds.
 *
 * A driver module returns `Db & SqliteAuthHandle`, and `createAuth` demands
 * the handle union - which is what stops a handle being mistagged. On `Db`
 * alone (`adapter: unknown`) a wrong `provider` beside it would only surface
 * as Better Auth issuing statements in the wrong dialect at runtime.
 */
export type SqliteAuthHandle = { adapter: SqliteDb; provider: "sqlite" };
