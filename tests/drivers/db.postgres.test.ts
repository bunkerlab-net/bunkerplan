import { describe, expect, test } from "bun:test";
import pg from "pg";
import { isPoolTimeout } from "../../src/db/unavailable.ts";
import { DATABASE_URL, postgresDb } from "./backends.ts";
import { describeAccountClosingRepo } from "./contract/account-closing-repo.ts";
import { describePlanRepo } from "./contract/plan-repo.ts";
import { describeRateLimitRepo } from "./contract/rate-limit-repo.ts";
import { describeSchema } from "./contract/schema.ts";
import { describeUnlockRateLimitRepo } from "./contract/unlock-rate-limit-repo.ts";

/**
 * `DB_DRIVER=postgres`, against a real server in a scratch schema.
 *
 * This is the dialect the SQLite suites cannot stand in for. Postgres reads
 * the plan count from its own snapshot under READ COMMITTED, so the ceiling is
 * held by an advisory lock rather than by SQLite serialising writers - and
 * that lock only exists against a server.
 */
const skip = DATABASE_URL === undefined;

describePlanRepo("Postgres", postgresDb, { skip });
describeRateLimitRepo("Postgres", postgresDb, { skip });
describeUnlockRateLimitRepo("Postgres", postgresDb, { skip });
describeAccountClosingRepo("Postgres", postgresDb, { skip });
describeSchema("Postgres", postgresDb, { skip });

/**
 * The one place the `pg` version is actually watched.
 *
 * `isPoolTimeout` recognises a pool acquisition timeout by its message, since
 * `pg` raises it with no SQLSTATE - and `pg` is a caret range, so a future
 * 8.x could reword it. Every other test around this injects the literal and
 * therefore proves only the predicate. This one provokes the real thing and
 * reads what `pg` emits, so an upgrade that changed the wording fails here
 * rather than quietly downgrading a 503 to a 500 in production.
 */
describe.skipIf(skip)("the pg pool timeout this build recognises", () => {
  test("still says what isPoolTimeout looks for", async () => {
    // One slot, so the second caller has nothing to be handed. The deadline is
    // generous enough that a slow CI connect does not fail the *first*
    // acquisition - it only has to be shorter than the test, since the second
    // caller waits on a slot that is never released rather than on the server.
    const pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 1_000,
    });
    let held: pg.PoolClient | undefined;

    try {
      // Inside the `try`, so a first connect that itself fails still reaches
      // `pool.end()` below rather than leaking the pool into the rest of the
      // run.
      held = await pool.connect();

      const refused = await pool.connect().then(
        (client) => {
          client.release();
          return null;
        },
        (cause: unknown) => cause,
      );

      expect(refused).toBeInstanceOf(Error);
      expect(isPoolTimeout(refused)).toBe(true);
    } finally {
      held?.release();
      await pool.end();
    }
  }, 10_000);
});
