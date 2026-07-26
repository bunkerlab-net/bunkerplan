// D1Database is an ambient global from the generated
// worker-configuration.d.ts - see `bun run cf-typegen`.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Db } from "../services/types.ts";
import { createSqliteAccountClosingRepo } from "./account-closing.sqlite.ts";
import { createSqlitePlanRepo } from "./plans.sqlite.ts";
import { createSqliteRateLimitRepo } from "./rate-limits.sqlite.ts";
import { sqliteSchema } from "./sqlite-shared.ts";

/**
 * D1 enforces foreign keys unconditionally (equivalent to
 * `PRAGMA foreign_keys = ON` for every transaction), so the ON DELETE CASCADE
 * constraints in the schema are live without any extra setup.
 */
export function createD1Db(binding: D1Database): Db {
  const db = drizzle(binding as never, { schema: sqliteSchema });
  return {
    adapter: db,
    provider: "sqlite",
    plans: createSqlitePlanRepo(db),
    uploadRateLimits: createSqliteRateLimitRepo(db),
    accountClosing: createSqliteAccountClosingRepo(db),
    async probe() {
      await db.run(sql`select 1`);
    },
  };
}
