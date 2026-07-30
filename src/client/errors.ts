/**
 * The message to show for a failure, thrown or returned.
 *
 * `String(cause)` is not the fallback: a plain object renders as
 * "[object Object]", and an `Error` carrying an empty message would blank the
 * line entirely. `fallback` is the wording the failure has when nothing usable
 * came back, so a thrown failure and a returned one read alike.
 *
 * Better Auth also rejects with `{ message }` shapes that are not `Error`
 * instances, so those are read too.
 */
export function messageOf(cause: unknown, fallback: string): string {
  /*
   * One read, as `unknown`, before anything is called on it. `Error.message`
   * is writable, so a runtime-mutated one can be a number - and `trim()` on
   * that throws, from inside the catch handler that was trying to report a
   * failure. An `Error` is an object carrying `message`, so this covers both
   * shapes rather than testing them separately.
   */
  const message: unknown =
    typeof cause === "object" && cause !== null && "message" in cause
      ? cause.message
      : undefined;

  // Trimmed, not merely compared to "": a message of spaces renders as a blank
  // line, which is the same nothing an empty one gives.
  return typeof message === "string" && message.trim() !== ""
    ? message
    : fallback;
}
