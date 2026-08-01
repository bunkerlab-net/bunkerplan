// D1Database is an ambient global from the generated
// worker-configuration.d.ts - see `bun run cf-typegen`.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Logger } from "../log.ts";
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
 * D1 enforces foreign keys unconditionally (equivalent to
 * `PRAGMA foreign_keys = ON` for every transaction), so the ON DELETE CASCADE
 * constraints in the schema are live without any extra setup.
 */
export function createD1Db(
  binding: D1Database,
  logger: Pick<Logger, "warn">,
): Db & SqliteAuthHandle {
  const db = drizzle(binding as never, { schema: sqliteSchema });
  const dialect = sqliteDialect(db);
  return {
    adapter: db,
    provider: "sqlite",
    plans: createPlanRepo(dialect),
    uploadRateLimits: createRateLimitRepo(
      dialect,
      dialect.tables.uploadRateLimit,
    ),
    unlockRateLimits: createUnlockRateLimitRepo(dialect, logger),
    accountClosing: createAccountClosingRepo(dialect),
    async probe() {
      await db.run(sql`select 1`);
    },
  };
}
