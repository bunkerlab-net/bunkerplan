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
 * Whether a thrown value is the server having cancelled its own statement.
 *
 * SQLSTATE `57014` (`query_canceled`) and nothing else, because this decides
 * whether the caller is told to retry and only this code earns that. The
 * server raised it, which means the server is still there, the statement did
 * not run, and the transaction around it is aborted. Repeating the request is
 * safe because the first attempt provably did nothing.
 *
 * `pg`'s own `query_timeout` is deliberately not included. It fires from this
 * end without the server having answered, so what happened over there is
 * unknown - the statement may still be running, and if the deadline landed on
 * a `COMMIT` the transaction may yet commit. Nothing may promise a safe retry
 * on that. src/db/postgres.ts sets the client deadline past the server's so
 * the defined one wins the race and this is the ordinary answer; a client-side
 * timeout means the server stopped answering entirely, which is a fault
 * rather than a queue.
 *
 * Matched on the code alone, never the message. Text varies by server locale
 * and would catch unrelated failures that merely say "timeout".
 */
export function isTimeout(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "57014"
  );
}
