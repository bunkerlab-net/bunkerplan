/**
 * A database call that was refused by a deadline, and provably left nothing
 * behind.
 *
 * Both halves are the contract. This is what earns a 503 and an invitation to
 * repeat the request, so it may only be raised where the caller can show the
 * work did not persist - a rollback that is known, not assumed. Anything less
 * certain is an ordinary throw and a 500: worse to read, and the only honest
 * answer when nobody can say whether the write landed.
 *
 * A cancellation seen at or around `COMMIT` is exactly that less-certain case
 * and is deliberately excluded. `pgClaim` in src/db/pg-shared.ts catches the
 * server's `57014` around the advisory-lock wait alone, where nothing has been
 * written yet - never around `db.transaction`, from where the same code could
 * have come from the commit and the outcome would be unknown. The two other
 * sources are the lock timeout, which is the wait itself expiring, and the
 * pool refusing to hand out a client, which happens before any statement is
 * sent.
 *
 * A leaf module on purpose: it imports nothing, so the HTTP layer can name this
 * without reaching into a driver. Nothing reachable from
 * src/runtime/cloudflare.ts may import `pg`, and a handler that had to check a
 * Postgres error code would have to.
 */
export class DatabaseUnavailable extends Error {
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`the database did not answer in time: ${operation}`, options);
    this.name = "DatabaseUnavailable";
  }
}

/**
 * `pg`'s message when `connectionTimeoutMillis` expires waiting for a client.
 *
 * No SQLSTATE, because no server was involved - which is also why matching the
 * text is tolerable here. `pg` raises it from its own pool.
 *
 * Coupled to that wording, and `pg` is a caret range (`^8.22.0`) rather than a
 * pin, so any 8.x could in principle reword it. The exposure is small and
 * one-directional: a pool timeout would stop being recognised and answer 500
 * instead of 503, which is a worse message rather than a wrong outcome.
 *
 * tests/pg-dialect.test.ts covers the predicate by injecting this same
 * literal, so it proves the classification and nothing about `pg`. What
 * watches the dependency is the pool-timeout test in
 * tests/drivers/db.postgres.test.ts, which provokes a real one against a real
 * server and reads the message `pg` actually emits.
 */
const POOL_TIMEOUT = "timeout exceeded when trying to connect";

/**
 * The pool giving up before a client was ever handed out.
 *
 * The cleanest failure to promise a retry on: no connection, so no statement
 * was sent, so nothing anywhere changed.
 */
export function isPoolTimeout(cause: unknown): boolean {
  return cause instanceof Error && cause.message === POOL_TIMEOUT;
}

/**
 * The SQLSTATE an error carries, looked for through whatever wrapped it.
 *
 * Drizzle does not re-throw what the driver threw. Every failing statement
 * arrives as its own `Error` - "Failed query: ..." - with the `pg` error, and
 * the only copy of the code, hanging off `cause`. Reading `code` from the top
 * object alone finds it on a bare driver error and never on a real one, which
 * is the shape every caller here actually meets.
 *
 * The chain is walked rather than probed one deep, and bounded so a cause that
 * points at itself cannot spin. Nothing in this codebase nests two wrappers
 * today; the bound costs nothing and removes the question.
 */
function sqlState(cause: unknown): string | undefined {
  for (let step = 0, at = cause; step < 5; step += 1) {
    if (typeof at !== "object" || at === null) return undefined;
    if ("code" in at && typeof at.code === "string") return at.code;
    if (!("cause" in at)) return undefined;
    at = at.cause;
  }
  return undefined;
}

/**
 * The server having cancelled a statement - SQLSTATE `57014`, which is what
 * `statement_timeout` raises.
 *
 * Safe to retry only where the caller knows which statement it was. That is
 * why this is a predicate and not a translation: `statement_timeout` stays
 * armed through the transaction commands too, so a cancellation seen from
 * outside `db.transaction` may have landed on the `COMMIT`, and whether the
 * transaction committed is then genuinely unknown. Callers apply this around
 * the one statement whose cancellation they can reason about - see `pgClaim`
 * in src/db/pg-shared.ts, which wraps the advisory-lock wait and nothing else.
 *
 * Matched on the code, never the message: server text varies by locale and
 * would catch unrelated failures that merely say "timeout".
 *
 * `pg`'s own `query_timeout` is not this and is deliberately absent
 * everywhere. It fires from this end without the server having answered, so
 * the statement may still be running. src/db/postgres.ts sets that deadline
 * past the server's so the defined one wins the race.
 */
export function isStatementCancelled(cause: unknown): boolean {
  return sqlState(cause) === "57014";
}

/**
 * The server refusing to keep waiting for a lock - SQLSTATE `55P03`
 * (`lock_not_available`), which `lock_timeout` raises.
 *
 * Contention named exactly, where `57014` only says something was cancelled.
 * Safe on the same grounds and then some: the statement that timed out was the
 * wait itself, so it never held the lock and never wrote anything, and the
 * transaction around it is aborted regardless.
 */
export function isLockUnavailable(cause: unknown): boolean {
  return sqlState(cause) === "55P03";
}
