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
 * Whether a thrown value is Postgres refusing to wait any longer.
 *
 * Two deadlines produce it and they report differently. `statement_timeout` is
 * the server cancelling its own query, which arrives as SQLSTATE `57014`
 * (`query_canceled`). `query_timeout` is `pg` giving up from this end, which
 * never reached the server and so carries no SQLSTATE at all - only a message.
 * Matching the text is unpleasant and is what the client-side deadline leaves;
 * it is narrow, and the code covers the case that matters most.
 */
export function isTimeout(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  if ("code" in cause && cause.code === "57014") return true;
  return (
    cause instanceof Error && cause.message.toLowerCase().includes("timeout")
  );
}
