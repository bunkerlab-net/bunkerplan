import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "../services/types.ts";
import { pgSchema } from "./pg-shared.ts";
import { createPgPlanRepo } from "./plans.pg.ts";
import { createPgRateLimitRepo } from "./rate-limits.pg.ts";

/**
 * Postgres always enforces foreign keys, so the ON DELETE CASCADE constraints
 * are live. `pg` is Node-only — this module MUST NOT be reachable from
 * src/runtime/cloudflare.ts.
 */
export function createPostgresDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema: pgSchema });
  return {
    adapter: db,
    provider: "pg",
    plans: createPgPlanRepo(db),
    uploadRateLimits: createPgRateLimitRepo(db),
    async probe() {
      await db.execute(sql`select 1`);
    },
  };
}
