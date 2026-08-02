import { describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect, type PgTransactionConfig } from "drizzle-orm/pg-core";
import type pg from "pg";
import { type PgDb, pgDialect } from "../src/db/pg-shared.ts";
import { probeOnce } from "../src/db/postgres.ts";
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

  test("bounds and takes the lock before the body reads anything", async () => {
    const { db, recorded } = recordingDb();

    await pgDialect(db).claim("user-a", async (executor) => {
      await executor.rows(sql`select 1 as body`);
      return null;
    });

    // The deadline first, or it would not apply to the wait it exists to
    // bound. Then the lock, which is what makes count-and-claim one critical
    // section - a body that ran before it would be counting against an
    // unguarded table.
    expect(recorded.statements[0]).toContain("lock_timeout");
    expect(recorded.statements[1]).toContain("pg_advisory_xact_lock");
    expect(recorded.statements[2]).toBe("select 1 as body");
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
      expect.stringContaining("lock_timeout"),
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

  /**
   * Throws from the advisory-lock wait, which is the *second* `tx.execute`.
   *
   * The first is `set local lock_timeout`, and failing that instead would
   * exercise the same catch while proving nothing about the wait this suite
   * is named for - a claim that could not even set its deadline is a
   * different fault. Counting the calls is what keeps the double honest as
   * the statements before the lock change.
   */
  function lockFails(cause: unknown): PgDb {
    return {
      execute: async () => ({ rows: [] }),
      transaction: async (body: (tx: unknown) => Promise<unknown>) => {
        let executed = 0;
        return await body({
          execute: async () => {
            executed += 1;
            if (executed === 1) return { rows: [] };
            throw cause;
          },
        });
      },
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

  test("translates the lock wait hitting its own timeout", async () => {
    // SQLSTATE 55P03, raised by the `lock_timeout` the claim sets. The wait
    // itself is what expired, so it never held the lock and never wrote -
    // contention named exactly, where 57014 only says something was cancelled.
    const contended = Object.assign(
      new Error("canceling statement due to lock timeout"),
      { code: "55P03" },
    );

    await expect(claim(lockFails(contended))).rejects.toBeInstanceOf(
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

/**
 * The health probe's two abort windows, which need a pool this test controls.
 *
 * `probeOnce` races `pool.connect()` against the caller's signal, and the
 * losing side still has to be tidied: a client that turns up after the caller
 * walked away must be destroyed rather than parked, because the deadline that
 * expired is shorter than the query timeout the connection is still under.
 * Parking it hands the next request a connection with an answer still coming
 * down it.
 *
 * Neither window is reachable by timing from outside. The second one below is
 * the subtle half: `acquire` attaches its abort listener after calling
 * `connect`, so a signal that aborts in between is never heard by the race -
 * `connect` wins, and the check after it is the only thing left that notices.
 */
describe("the health probe's deadline", () => {
  interface FakeClient {
    released: Array<Error | undefined>;
    queries: string[];
  }

  /**
   * A pool handing back one client. `beforeResolve` runs between the promise
   * being created and `connect` returning it, which is the seam the windows
   * live in.
   */
  function fakePool(beforeResolve: () => void = () => {}): {
    pool: pg.Pool;
    client: FakeClient;
  } {
    const client: FakeClient = { released: [], queries: [] };
    const handle = {
      query: async (statement: string) => {
        client.queries.push(statement);
        return { rows: [] };
      },
      release: (broken?: Error) => {
        client.released.push(broken);
      },
    };
    const pool = {
      connect: () => {
        const pending = Promise.resolve(handle);
        beforeResolve();
        return pending;
      },
    };
    return { pool: pool as unknown as pg.Pool, client };
  }

  /**
   * The other side of the race, and the leak the whole arrangement exists to
   * stop. `pool.connect` takes no signal, so an acquisition the caller stopped
   * waiting for is not cancelled - the client still turns up, after nobody is
   * left to use it. Parking that one returns a connection to the pool while
   * whatever it was waiting on may still be coming down it; destroying it
   * frees the slot at the abort instead.
   */
  test("destroys a client that turns up after the wait was abandoned", async () => {
    const reason = new Error("probe deadline");
    const controller = new AbortController();
    const released: Array<Error | undefined> = [];
    const { promise: pending, resolve } = Promise.withResolvers<unknown>();
    const pool = { connect: () => pending } as unknown as pg.Pool;

    const probing = probeOnce(pool, controller.signal);
    controller.abort(reason);
    await expect(probing).rejects.toThrow(reason);

    // Nothing released yet: the pool has not handed anything over.
    expect(released).toEqual([]);

    // Now it does, long after the caller gave up.
    resolve({
      query: async () => ({ rows: [] }),
      release: (broken?: Error) => {
        released.push(broken);
      },
    });
    // The tidying handler was attached to this promise before this line was
    // reached, and handlers run in the order they were registered - so by the
    // time this await resumes, it has already run. No clock involved.
    await pending;

    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
    expect(released[0]?.message).toContain("abandoned");
  });

  /**
   * And the same acquisition failing instead of arriving. Nothing is waiting
   * on that promise any more - the caller already has its rejection - so a
   * rejection left unhandled here takes the process down over a database blip
   * the request itself already survived. The empty handler beside the tidying
   * one is what stops that, and it is invisible until it is missing.
   */
  test("swallows an acquisition that fails after the wait was abandoned", async () => {
    const reason = new Error("probe deadline");
    const controller = new AbortController();
    const { promise: pending, reject } = Promise.withResolvers<never>();
    const pool = { connect: () => pending } as unknown as pg.Pool;

    const probing = probeOnce(pool, controller.signal);
    controller.abort(reason);
    await expect(probing).rejects.toThrow(reason);

    reject(new Error("connection refused"));
    // Registered after the handler under test, so this resuming means that
    // one has already taken the rejection: the promise is handled, and no
    // `unhandledrejection` can follow.
    await expect(pending).rejects.toThrow("connection refused");

    // The caller still has its own reason, and no client was ever released
    // because none ever arrived.
    await expect(probing).rejects.toThrow(reason);
  });

  test("asks its one question and parks the client when nothing aborts", async () => {
    const { pool, client } = fakePool();

    await probeOnce(pool);

    expect(client.queries).toEqual(["select 1"]);
    // Parked, not destroyed: `undefined` is what returns a healthy connection
    // to the pool.
    expect(client.released).toEqual([undefined]);
  });

  test("refuses a signal already aborted before it asks for a client", async () => {
    const reason = new Error("probe deadline");
    const { pool, client } = fakePool();

    await expect(probeOnce(pool, AbortSignal.abort(reason))).rejects.toThrow(
      reason,
    );

    // Never acquired, so there is nothing to tidy.
    expect(client.queries).toEqual([]);
    expect(client.released).toEqual([]);
  });

  /**
   * The window `acquire` cannot see. The signal aborts after `connect` was
   * called and before the listener was attached, so the abort has already been
   * dispatched to nobody and the race resolves with a live client the caller
   * no longer wants.
   */
  test("destroys a client that arrived after the caller gave up", async () => {
    const reason = new Error("probe deadline");
    const controller = new AbortController();
    const { pool, client } = fakePool(() => controller.abort(reason));

    await expect(probeOnce(pool, controller.signal)).rejects.toThrow(reason);

    // The query never ran - the point is the deadline, not a slow server.
    expect(client.queries).toEqual([]);
    // Destroyed rather than parked. An argument here is what discards the
    // connection instead of returning it to the pool.
    expect(client.released).toHaveLength(1);
    expect(client.released[0]).toBeInstanceOf(Error);
    expect(client.released[0]?.message).toContain("abandoned");
  });

  /**
   * A query that fails on its own, with no abort in sight, still destroys the
   * connection: a statement that errored can leave the protocol mid-message,
   * so the client is not fit to hand out again.
   */
  test("destroys the client when the question itself fails", async () => {
    const failure = new Error("connection reset");
    const { pool, client } = fakePool();
    const broken = {
      ...pool,
      connect: async () => ({
        query: async () => {
          throw failure;
        },
        release: (cause?: Error) => {
          client.released.push(cause);
        },
      }),
    } as unknown as pg.Pool;

    await expect(probeOnce(broken)).rejects.toThrow(failure);

    expect(client.released).toEqual([failure]);
  });

  /**
   * And when both happen, the caller's reason wins. Destroying the connection
   * is what makes the in-flight query reject, so reporting the driver's socket
   * error would answer a different question from the two abort paths above -
   * for the same event.
   */
  test("reports the caller's reason when the abort is what broke the query", async () => {
    const reason = new Error("probe deadline");
    const controller = new AbortController();
    const released: Array<Error | undefined> = [];
    const pool = {
      connect: async () => ({
        query: async () => {
          controller.abort(reason);
          throw new Error("terminating connection");
        },
        release: (cause?: Error) => {
          released.push(cause);
        },
      }),
    } as unknown as pg.Pool;

    await expect(probeOnce(pool, controller.signal)).rejects.toThrow(reason);

    expect(released).toHaveLength(1);
  });
});
