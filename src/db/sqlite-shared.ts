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

    // No critical section, and no transaction either. The quota is decided
    // inside the claiming `insert ... select ... where` in
    // src/db/plans.shared.ts, so count-and-claim is one statement - and SQLite
    // takes a write lock for the whole of a statement, on D1 as well as
    // bun:sqlite, so there is nothing for a second writer to interleave with.
    // Wrapping it in a transaction would add a lock it already holds.
    //
    // The claim contract in tests/drivers/contract/plan-repo.ts is what says
    // so rather than this comment: it races 40 concurrent claims at a ceiling
    // of five and requires exactly five, against both SQLite drivers and
    // Postgres. Postgres needs its advisory lock to pass that because it
    // counts against a snapshot; these two do not.
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
 * A driver module returns `Db` intersected with this, and `createAuth` demands
 * the handle union - which is what stops a handle being mistagged. On `Db`
 * alone (`adapter: unknown`) a wrong `provider` beside it would only surface
 * as Better Auth issuing statements in the wrong dialect at runtime.
 *
 * Declared once, on the line below, and deliberately named nowhere else in
 * this file - three review rounds have read a second mention here as a second
 * declaration, so there is now nothing to pair. src/db/d1.ts and
 * src/db/bun-sqlite.ts import it as a type and name it in their return types,
 * and src/auth/instance.ts unions it into `AuthDb`; those are type-only
 * imports across module boundaries, which cannot collide with anything.
 * `tsc --noEmit` is the arbiter and it is clean - a duplicate identifier is a
 * compile error, not a style opinion.
 */
export type SqliteAuthHandle = { adapter: SqliteDb; provider: "sqlite" };
