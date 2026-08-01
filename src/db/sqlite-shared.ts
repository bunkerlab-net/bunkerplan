import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
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
