import type { Logger } from "../log.ts";
import type {
  AccountClosingRepo,
  PlanRepo,
  PlanStorage,
} from "../services/types.ts";

export interface StorePlanDeps {
  storage: PlanStorage;
  plans: PlanRepo;
  accountClosing: AccountClosingRepo;
  logger: Logger;
}

/**
 * Removes an object whose row does not, or no longer, own it - and reports a
 * failure to do so rather than raising.
 *
 * The compensation half of every write ordering in this module and the two
 * handlers beside it. What it can never do is fail the request it is cleaning
 * up after: the row is already gone (or was never this caller's), so the
 * caller's answer is settled, and a throw here would turn a correct 204 or 404
 * into a 500. What is left instead is a log line naming the id, which is the
 * only handle anything still has on those bytes.
 *
 * Deliberately not an ordering: each caller decides whether the object goes
 * first or the row does, and documents why. This is only the sweep.
 */
export async function sweepOrphanedObject(
  storage: Pick<PlanStorage, "delete">,
  logger: Pick<Logger, "error">,
  id: string,
): Promise<void> {
  await storage.delete(id).catch((error: unknown) => {
    logger.error({ err: error, planId: id }, "orphaned plan object");
  });
}

/**
 * Writes the object for a plan row that has already been claimed, and confirms
 * the row survived. Returns a reason when the plan could not be kept, or `null`
 * when it is safely stored.
 *
 * Deleting an account marks it, sweeps the objects its rows name, and lets the
 * foreign key take the rows. An upload can be mid-write across any part of
 * that, and if its object lands after the sweep passed, the object outlives the
 * row - served at `/p/{id}`, owned by nobody, reachable by nothing.
 *
 * BOTH checks below are load-bearing, for different interleavings:
 *
 * - The marker catches a deletion still running. Its sweep may already have
 *   passed this row, so the row being present proves nothing.
 * - The row catches a deletion that finished. `account_closing` cascades with
 *   the user, so once deletion completes the marker is gone too, and the
 *   marker alone would read as "all clear" for a plan whose row no longer
 *   exists.
 *
 * A deletion that starts after both checks necessarily sees the row and sweeps
 * the object itself, so there is no third case.
 */
export async function storeAndConfirm(
  deps: StorePlanDeps,
  id: string,
  userId: string,
  body: Uint8Array,
): Promise<"storage-unavailable" | "withdrawn" | null> {
  const { storage, plans, accountClosing, logger } = deps;

  try {
    await storage.put(id, body);
  } catch (error) {
    await plans.deleteOwned(id, userId);
    logger.error({ err: error, planId: id }, "plan upload failed");
    return "storage-unavailable";
  }

  const closing = await accountClosing.isOpen(userId);
  const owned = (await plans.findOwner(id)) === userId;
  if (!closing && owned) return null;

  // Object first, and the row stays if that fails. The row is the only handle
  // anything has on this object: the deletion sweep loops until no rows
  // remain, so a row left behind gets the object retried on the next pass,
  // whereas dropping it first strands the object where nothing will look
  // again. A plan whose URL 404s is recoverable; an unowned object is not.
  //
  // Not `sweepOrphanedObject`: that one cannot fail its caller, and here the
  // failure decides whether the row is dropped. This is the ordering, not the
  // sweep.
  try {
    await storage.delete(id);
  } catch (error) {
    logger.error({ err: error, planId: id }, "could not withdraw plan object");
    return "withdrawn";
  }
  await plans.deleteOwned(id, userId);
  return "withdrawn";
}
