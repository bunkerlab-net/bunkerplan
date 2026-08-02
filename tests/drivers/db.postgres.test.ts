import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import { pgDialect, pgSchema } from "../../src/db/pg-shared.ts";
import {
  DatabaseUnavailable,
  isPoolTimeout,
} from "../../src/db/unavailable.ts";
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
    /*
     * One pool, one slot, and one deadline serving both connects - which is
     * fine, because they are not racing the same clock in any real sense.
     *
     * The first `connect` opens a connection rather than queueing, so the
     * deadline is only covering a TCP handshake and an auth exchange against
     * a server on the same machine. The second has nowhere to be handed from
     * and nothing that will ever release, so it waits out the full deadline
     * however long it is.
     *
     * That asymmetry is why the number is generous: a value tight enough to
     * make the test quick is also tight enough to fail the *setup* on a loaded
     * CI runner, and a setup failure here is indistinguishable from the
     * assertion failing. Two seconds is far more than a local handshake needs
     * and is paid once.
     */
    const pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2_000,
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

/**
 * The claim under real contention, at both places it can meet it.
 *
 * These are the tests that were missing, and their absence hid a live fault.
 * Every other check of this translation injects a synthetic error with `code`
 * set on it - which proves the predicate and nothing about the shape the
 * driver actually throws. Drizzle does not re-throw the `pg` error: it wraps
 * it in a "Failed query" `Error` and hangs the original, with the only copy of
 * the SQLSTATE, off `cause`. So the predicates matched injected errors and no
 * real one, and both retryable outcomes reached the handler as faults - 500
 * where the contract says 503 with a `retry-after`, for a transaction that
 * rolled back having written nothing.
 *
 * Provoked here instead: a real lock, a real server, a real deadline.
 */
describe.skipIf(skip)("a claim that loses a race for a lock", () => {
  /** The key `pgClaim` derives, recomputed so the holder can take it first. */
  async function lockKey(userId: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(userId),
    );
    return BigInt.asIntN(64, new DataView(digest).getBigUint64(0)).toString();
  }

  test("answers DatabaseUnavailable when the advisory lock is held", async () => {
    const holder = new pg.Client({ connectionString: DATABASE_URL });
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await holder.connect();

    try {
      await holder.query("begin");
      await holder.query(
        `select pg_advisory_xact_lock(${await lockKey("user-a")})`,
      );
      let entered = false;
      const db = drizzlePg(pool, { schema: pgSchema });
      const claiming = pgDialect(db).claim("user-a", async () => {
        entered = true;
        return null;
      });
      await expect(claiming).rejects.toBeInstanceOf(DatabaseUnavailable);
      // The lock is the first statement, so the body never ran - which is the
      // ground the retry stands on.
      expect(entered).toBe(false);
      await holder.query("rollback");
    } finally {
      await holder.end();
      await pool.end();
    }
  }, 15_000);
});

/**
 * The claim's body under real row contention.
 *
 * `pgClaim` sets `lock_timeout` on the transaction, so it governs the body as
 * well as the advisory-lock statement - the count and the insert can wait on a
 * row lock and end in `55P03` the same way.
 */
describe.skipIf(skip)("a claim whose body waits on a row", () => {
  test("answers DatabaseUnavailable rather than a fault", async () => {
    // A table of its own, so nothing here depends on the migrated schema and
    // no other suite can be the thing this blocks on.
    const table = `claim_contention_${crypto.randomUUID().replaceAll("-", "")}`;
    const holder = new pg.Client({ connectionString: DATABASE_URL });
    const pool = new pg.Pool({ connectionString: DATABASE_URL });

    await holder.connect();
    try {
      await holder.query(`create table ${table} (id int primary key)`);
      await holder.query(`insert into ${table} values (1)`);
      await holder.query("begin");
      await holder.query(`select * from ${table} where id = 1 for update`);

      const db = drizzlePg(pool, { schema: pgSchema });
      const claiming = pgDialect(db).claim("user-a", async (executor) => {
        await executor.run(sql.raw(`update ${table} set id = 2 where id = 1`));
        return null;
      });

      // The type is the contract: src/http/create-plan.ts answers 503 with a
      // `retry-after` to this and 500 to anything else.
      await expect(claiming).rejects.toBeInstanceOf(DatabaseUnavailable);
      await holder.query("rollback");

      // And the body's write is not there, which is what earns the retry.
      const { rows } = await holder.query<{ id: number }>(
        `select id from ${table}`,
      );
      expect(rows).toEqual([{ id: 1 }]);
    } finally {
      await holder.query(`drop table if exists ${table}`).catch(() => {});
      await holder.end();
      await pool.end();
    }
  }, 15_000);
});
