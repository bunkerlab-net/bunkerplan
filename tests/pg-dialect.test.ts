import { describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect, type PgTransactionConfig } from "drizzle-orm/pg-core";
import { type PgDb, pgDialect } from "../src/db/pg-shared.ts";
import { DatabaseUnavailable } from "../src/db/unavailable.ts";

/**
 * The wiring `tests/drivers/db.postgres.test.ts` cannot see.
 *
 * That suite proves the plan ceiling holds against a real server, but only at
 * whatever isolation the server defaults to - which is `read committed`, so a
 * claim that stopped asking for it would still pass every assertion there. The
 * request is the thing worth pinning: `default_transaction_isolation` is an
 * operator's setting, and at `repeatable read` the whole transaction reads one
 * snapshot taken before the advisory lock is granted, so a waiter counts the
 * account as it stood before the previous holder wrote and the ceiling admits
 * one plan too many. Named on the `begin`, none of that can reach the claim.
 */

interface Recorded {
  configs: Array<PgTransactionConfig | undefined>;
  statements: string[];
}

/**
 * Enough of a `PgDb` for `pgDialect` to build against: `execute` for the
 * statements, `transaction` for the claim. Nothing here reaches Postgres - the
 * point is what the dialect asks for, not what a server does with it.
 */
function recordingDb(): { db: PgDb; recorded: Recorded } {
  const recorded: Recorded = { configs: [], statements: [] };
  // The driver's own renderer, so a chunk carrying a bound parameter reads as
  // `$1` here rather than as an object.
  const render = new PgDialect();
  // Two distinct functions, deliberately. One shared `execute` would record a
  // statement identically whichever handle issued it, so the test below could
  // not tell a body running on the transaction from one running on the pool -
  // which is the difference it exists to assert.
  const onTransaction = async (query: SQL) => {
    recorded.statements.push(render.sqlToQuery(query).sql.trim());
    return { rows: [] };
  };
  const onPool = async (query: SQL) => {
    recorded.statements.push(`POOL: ${render.sqlToQuery(query).sql.trim()}`);
    return { rows: [] };
  };
  const db = {
    execute: onPool,
    transaction: async (
      body: (tx: unknown) => Promise<unknown>,
      config?: PgTransactionConfig,
    ) => {
      recorded.configs.push(config);
      return await body({ execute: onTransaction });
    },
  };
  return { db: db as unknown as PgDb, recorded };
}

describe("the Postgres claim", () => {
  test("begins at read committed rather than the server's default", async () => {
    const { db, recorded } = recordingDb();

    await pgDialect(db).claim("user-a", async () => "claimed");

    expect(recorded.configs).toEqual([{ isolationLevel: "read committed" }]);
  });

  test("takes the advisory lock before the body reads anything", async () => {
    const { db, recorded } = recordingDb();

    await pgDialect(db).claim("user-a", async (executor) => {
      await executor.rows(sql`select 1 as body`);
      return null;
    });

    // The lock is what makes count-and-claim one critical section; a body that
    // ran before it would be counting against an unguarded table.
    expect(recorded.statements[0]).toContain("pg_advisory_xact_lock");
    expect(recorded.statements[1]).toBe("select 1 as body");
  });

  test("hands the body the transaction, not the pool", async () => {
    const { db, recorded } = recordingDb();

    const returned = await pgDialect(db).claim("user-a", async (executor) => {
      await executor.run(sql`insert into marker default values`);
      return "body-result";
    });

    // A body writing outside the transaction escapes the lock and the rollback
    // both, which is the whole reason the executor is passed in rather than
    // closed over. The `POOL:` prefix is what a statement issued on the pool
    // would carry, and nothing here may.
    expect(returned).toBe("body-result");
    expect(recorded.statements).toEqual([
      expect.stringContaining("pg_advisory_xact_lock"),
      "insert into marker default values",
    ]);
    expect(recorded.statements.filter((s) => s.startsWith("POOL:"))).toEqual(
      [],
    );
  });
});

/**
 * The one Postgres failure the layers above are allowed to know about.
 *
 * Waiting for the claim's advisory lock is a statement, so a deep enough queue
 * ends at `statement_timeout` rather than in a hang. Nothing was claimed and
 * the transaction rolled back, so the caller should be told to come back -
 * which the HTTP layer can only do if it is told which failure this was, and
 * it cannot read a SQLSTATE without `pg` in the Workers bundle.
 */
describe("a claim that runs out of time", () => {
  function failingDb(cause: unknown): PgDb {
    return {
      execute: async () => ({ rows: [] }),
      transaction: async () => {
        throw cause;
      },
    } as unknown as PgDb;
  }

  const claim = (cause: unknown) =>
    pgDialect(failingDb(cause)).claim("user-a", async () => null);

  test("translates the server cancelling its own statement", async () => {
    // SQLSTATE 57014, `query_canceled`, which is what `statement_timeout`
    // raises.
    const cancelled = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );

    await expect(claim(cancelled)).rejects.toBeInstanceOf(DatabaseUnavailable);
  });

  test("translates the client giving up before the server answered", async () => {
    // `query_timeout` never reaches the server, so it carries no SQLSTATE and
    // the message is all there is to go on.
    await expect(claim(new Error("Query read timeout"))).rejects.toBeInstanceOf(
      DatabaseUnavailable,
    );
  });

  test("leaves every other failure alone", async () => {
    // A constraint violation is an answer about this request, not about the
    // deployment. Dressed as a 503 it would invite a retry that cannot work.
    const violation = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });

    await expect(claim(violation)).rejects.toThrow("duplicate key value");
    await expect(claim(violation)).rejects.not.toBeInstanceOf(
      DatabaseUnavailable,
    );
  });
});
