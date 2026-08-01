import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../services/types.ts";
import { createAccountClosingRepo } from "./account-closing.shared.ts";
import { createPlanRepo } from "./plans.shared.ts";
import {
  createRateLimitRepo,
  createUnlockRateLimitRepo,
} from "./rate-limits.shared.ts";
import {
  type SqliteAuthHandle,
  sqliteDialect,
  sqliteSchema,
} from "./sqlite-shared.ts";

/**
 * Local-file SQLite. `drizzle-orm/bun-sqlite` statically imports `bun:sqlite`,
 * so this module MUST NOT be reachable from src/runtime/cloudflare.ts - that is
 * why the D1 driver lives in its own file. It also requires the Bun runtime;
 * self-hosters on plain Node must use DB_DRIVER=postgres.
 */
export function createBunSqliteDb(path: string): Db & SqliteAuthHandle {
  const handle = new Database(path, { create: true });
  // SQLite defaults foreign key enforcement to OFF per connection. Without
  // this the ON DELETE CASCADE constraints silently do nothing and account
  // deletion leaves orphan passkey/apikey/plan rows.
  handle.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(handle, { schema: sqliteSchema });
  const dialect = sqliteDialect(db);
  return {
    adapter: db,
    provider: "sqlite",
    plans: createPlanRepo(dialect),
    uploadRateLimits: createRateLimitRepo(
      dialect,
      dialect.tables.uploadRateLimit,
    ),
    unlockRateLimits: createUnlockRateLimitRepo(dialect),
    accountClosing: createAccountClosingRepo(dialect),
    async probe() {
      await db.run(sql`select 1`);
    },
  };
}
