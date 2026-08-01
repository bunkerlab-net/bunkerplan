import type { Logger } from "../log.ts";
import type { PlanStorage } from "../services/types.ts";

/**
 * Removes an object whose row does not, or no longer, own it - and reports a
 * failure to do so rather than raising.
 *
 * The compensation half of the write orderings in src/http/store-plan.ts,
 * src/http/replace-plan.ts, and src/http/delete-plan.ts. Its own module
 * because all three reach for it and none of them owns it: an upload, a
 * replacement, and a delete arrive here from opposite directions.
 *
 * What it can never do is fail the request it is cleaning up after: the row is
 * already gone (or was never this caller's), so the caller's answer is settled,
 * and a throw here would turn a correct 204 or 404 into a 500. What is left
 * instead is a log line naming the id, which is the only handle anything still
 * has on those bytes.
 *
 * Deliberately not an ordering: each caller decides whether the object goes
 * first or the row does, and documents why. This is only the sweep.
 */
export async function sweepOrphanedObject(
  storage: Pick<PlanStorage, "delete">,
  logger: Pick<Logger, "error">,
  id: string,
): Promise<void> {
  // `try`, not `.catch`: a `delete` that throws before returning its promise
  // never gets a handler attached, and the rejection this exists to swallow
  // would instead replace a response the route has already decided on.
  try {
    await storage.delete(id);
  } catch (error) {
    logger.error(
      { err: error, planId: id },
      "failed to delete an orphaned plan object; its bytes are still stored",
    );
  }
}
