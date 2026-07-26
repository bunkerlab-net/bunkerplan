import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "../services/types.ts";
import { createPgAccountClosingRepo } from "./account-closing.pg.ts";
import { pgSchema } from "./pg-shared.ts";
import { createPgPlanRepo } from "./plans.pg.ts";
import { createPgRateLimitRepo } from "./rate-limits.pg.ts";

/**
 * Postgres always enforces foreign keys, so the ON DELETE CASCADE constraints
 * are live. `pg` is Node-only - this module MUST NOT be reachable from
 * src/runtime/cloudflare.ts.
 *
 * The pool is bounded on purpose. `pg` defaults `connectionTimeoutMillis` to
 * `0`, meaning a request that cannot get a client waits forever, so a slow or
 * unreachable server turns into an unbounded pile of held requests rather than
 * errors. Failing after a few seconds lets a request return 5xx and free
 * itself. `statement_timeout` is the matching server-side bound: without it a
 * single pathological query holds its connection for as long as it likes.
 */
const POOL_MAX = 10;
const CONNECTION_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 15_000;

export function createPostgresDb(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  const db = drizzle(pool, { schema: pgSchema });
  return {
    adapter: db,
    provider: "pg",
    plans: createPgPlanRepo(db),
    uploadRateLimits: createPgRateLimitRepo(db),
    accountClosing: createPgAccountClosingRepo(db),
    async probe() {
      await db.execute(sql`select 1`);
    },
  };
}
