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
  // Trimmed, not merely compared to "": a message of spaces renders as a blank
  // line, which is the same nothing an empty one gives.
  if (cause instanceof Error && cause.message.trim() !== "")
    return cause.message;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim() !== ""
  ) {
    return cause.message;
  }
  return fallback;
}
