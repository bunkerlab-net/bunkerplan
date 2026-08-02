import type { SQL, SQLWrapper } from "drizzle-orm";

/**
 * The seam between the repositories and one drizzle instance.
 *
 * The repository modules beside this one are dialect-agnostic: they spell their
 * statements out in SQL both engines accept and reach a database only through
 * this interface, so a change to a decision lands once. Everything that
 * genuinely differs between SQLite and Postgres is named here and nowhere else
 * - which is the point, because these repositories used to be twin files that
 * drifted a comment at a time.
 *
 * Built by `sqliteDialect` in src/db/sqlite-shared.ts and `pgDialect` in
 * src/db/pg-shared.ts, each over its own schema objects and its own driver.
 */
export interface SqlExecutor {
  /**
   * Runs one statement and hands back its rows, keyed by result column name.
   *
   * Rows arrive as the driver produced them - no drizzle field mapping - so a
   * statement wanting a camelCase key asks for a quoted alias, and a value the
   * two engines report differently is mapped where it is read. This is the one
   * call the two drivers spell differently: `db.all` on SQLite, and
   * `db.execute(...).rows` on Postgres.
   */
  rows<T extends Record<string, unknown>>(query: SQL): Promise<T[]>;
  /** Runs one statement whose rows nobody reads. */
  run(query: SQL): Promise<void>;
}

/**
 * The tables the repositories touch, named through their schema objects rather
 * than as strings: `user` is a reserved word in both engines, and only the
 * drizzle object knows to quote it.
 *
 * Column names are written out in the statements themselves, so this carries
 * tables alone. The contract suite in tests/drivers runs every statement
 * against both real engines, which is what catches a renamed column.
 */
export interface DialectTables {
  plan: SQLWrapper;
  planGrant: SQLWrapper;
  user: SQLWrapper;
  accountClosing: SQLWrapper;
  uploadRateLimit: SQLWrapper;
  unlockRateLimit: SQLWrapper;
}

export interface Dialect extends SqlExecutor {
  tables: DialectTables;

  /**
   * Runs a count-and-claim in whatever critical section the engine needs, and
   * hands the body the executor it must use for both halves.
   *
   * SQLite needs none, and gets none - not even a transaction. The body's
   * claim is a single `insert ... select ... where`, and SQLite holds a write
   * lock for the whole of one statement on D1 as well as bun:sqlite, so there
   * is nothing for a concurrent writer to interleave with. Wrapping it in
   * `BEGIN IMMEDIATE` would take a lock it already holds.
   *
   * Postgres counts against its snapshot instead, so two concurrent claims at
   * `maxPlans - 1` would both see room and both write; there the body runs in
   * a transaction holding an advisory lock on the account, released with the
   * transaction whichever way it ends.
   *
   * That both are correct is measured rather than argued:
   * tests/drivers/contract/plan-repo.ts races 40 concurrent claims at a
   * ceiling of five and requires exactly five, against D1, bun:sqlite, and
   * Postgres alike. Postgres fails it without its lock; the other two pass
   * without one.
   *
   * Either way the guarantee is statement-level, not per caller: two calls to
   * the claim are two units and nothing here makes them one.
   */
  claim<T>(
    userId: string,
    body: (executor: SqlExecutor) => Promise<T>,
  ): Promise<T>;

  /**
   * Turns a `created_at` as the driver reported it into a `Date`.
   *
   * The column is epoch milliseconds on SQLite and a timestamp on Postgres, so
   * each dialect maps the value through its own drizzle column - the same
   * mapping a query builder would have applied, rather than a second guess at
   * it here.
   */
  createdAt(value: unknown): Date;

  /** `max` on SQLite, `greatest` on Postgres: the same floor, two spellings. */
  floor(expr: SQL): SQL;
}
