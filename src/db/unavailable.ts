/**
 * A database call that was cut short by a deadline rather than answered.
 *
 * A leaf module on purpose: it imports nothing, so the HTTP layer can name this
 * without reaching into a driver. Nothing reachable from
 * src/runtime/cloudflare.ts may import `pg`, and a handler that had to check a
 * Postgres error code would have to.
 *
 * Distinct from any other failure because the answer to it is different. A
 * statement that timed out says nothing about the request being wrong - the
 * work was refused for taking too long, the transaction rolled back, and
 * nothing was written. That is a 503 and a retry, where an unclassified throw
 * is a 500 and a bug report.
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
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "57014"
  );
}
