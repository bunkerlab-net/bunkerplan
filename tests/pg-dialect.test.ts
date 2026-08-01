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
 * Which Postgres failures the layers above are allowed to retry on.
 *
 * Only the two that are known to have left nothing behind, and the position
 * matters as much as the code: `statement_timeout` stays armed through the
 * transaction commands, so a `57014` seen from outside `db.transaction` may
 * have landed on the `COMMIT` and the outcome is then unknown. It is caught
 * around the advisory-lock wait alone, where nothing has been written yet.
 */
describe("a claim that runs out of time", () => {
  const CANCELLED = Object.assign(
    new Error("canceling statement due to statement timeout"),
    { code: "57014" },
  );

  /** Throws from the lock statement, which is the first `tx.execute`. */
  function lockFails(cause: unknown): PgDb {
    return {
      execute: async () => ({ rows: [] }),
      transaction: async (body: (tx: unknown) => Promise<unknown>) =>
        await body({
          execute: async () => {
            throw cause;
          },
        }),
    } as unknown as PgDb;
  }

  /** Throws where the transaction itself does - acquisition, or the commit. */
  function transactionFails(cause: unknown): PgDb {
    return {
      execute: async () => ({ rows: [] }),
      transaction: async () => {
        throw cause;
      },
    } as unknown as PgDb;
  }

  const claim = (db: PgDb) => pgDialect(db).claim("user-a", async () => null);

  test("translates the lock wait being cancelled", async () => {
    // The queue this models: the lock is the first statement, so nothing was
    // written before it was cut short, and drizzle rolls back on the way out.
    await expect(claim(lockFails(CANCELLED))).rejects.toBeInstanceOf(
      DatabaseUnavailable,
    );
  });

  test("leaves a cancellation it cannot place alone", async () => {
    // The same code, thrown where `db.transaction` itself throws. That may be
    // the `COMMIT` being cancelled, and whether the transaction committed is
    // then unknown - the one thing a retryable answer may not be unsure of.
    await expect(claim(transactionFails(CANCELLED))).rejects.not.toBeInstanceOf(
      DatabaseUnavailable,
    );
  });

  test("translates the pool refusing to hand out a client", async () => {
    // `connectionTimeoutMillis`, raised by `pg`'s own pool before a
    // transaction exists. The cleanest of them: no statement was ever sent.
    await expect(
      claim(
        transactionFails(new Error("timeout exceeded when trying to connect")),
      ),
    ).rejects.toBeInstanceOf(DatabaseUnavailable);
  });

  test("leaves a client-side deadline alone", async () => {
    // `pg`'s own `query_timeout` never reached the server, so the statement
    // may still be running. src/db/postgres.ts sets it past the server's
    // deadline precisely so this is the unusual case.
    await expect(
      claim(lockFails(new Error("Query read timeout"))),
    ).rejects.not.toBeInstanceOf(DatabaseUnavailable);
  });

  test("leaves every other failure alone", async () => {
    // A constraint violation is an answer about this request, not about the
    // deployment. Dressed as a 503 it would invite a retry that cannot work.
    const violation = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });

    await expect(claim(lockFails(violation))).rejects.toThrow(
      "duplicate key value",
    );
    await expect(claim(lockFails(violation))).rejects.not.toBeInstanceOf(
      DatabaseUnavailable,
    );
  });
});
