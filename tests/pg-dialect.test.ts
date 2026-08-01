import { describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect, type PgTransactionConfig } from "drizzle-orm/pg-core";
import { type PgDb, pgDialect } from "../src/db/pg-shared.ts";

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
  const execute = async (query: SQL) => {
    recorded.statements.push(render.sqlToQuery(query).sql.trim());
    return { rows: [] };
  };
  const db = {
    execute,
    transaction: async (
      body: (tx: unknown) => Promise<unknown>,
      config?: PgTransactionConfig,
    ) => {
      recorded.configs.push(config);
      return await body({ execute });
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
    // closed over.
    expect(returned).toBe("body-result");
    expect(recorded.statements).toEqual([
      expect.stringContaining("pg_advisory_xact_lock"),
      "insert into marker default values",
    ]);
  });
});
