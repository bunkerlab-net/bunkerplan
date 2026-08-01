import type { AppAuth } from "../auth/instance.ts";
import type { Logger } from "../log.ts";
import type { PlanRepo, PlanStorage } from "../services/types.ts";
import { problem } from "./problem.ts";
import { resolveUserId } from "./require-user.ts";
import { sweepOrphanedObject } from "./store-plan.ts";

/**
 * Object first, row second - the mirror of the upload path.
 *
 * The public GET never consults the database, so an object whose row is gone
 * would be served forever with no owner and no way to remove it. Deleting the
 * object first means a storage failure loses nothing: the row is still there,
 * the plan is still listed, and the caller can retry. A database failure after
 * a successful object delete leaves only a stale row, which lists a plan whose
 * URL 404s and which the owner can retry away (object deletes are idempotent).
 *
 * The caller is resolved here rather than in the router, so a route registered
 * later cannot forget it. A key or a session: a credential that may replace the
 * document may destroy the plan. Unmetered - the upload allowance covers upload
 * and replace only, and this writes no object.
 */
export async function deletePlan(
  deps: {
    auth: AppAuth;
    storage: PlanStorage;
    plans: PlanRepo;
    logger: Logger;
  },
  request: Request,
  id: string,
): Promise<Response> {
  const { auth, storage, plans, logger } = deps;
  const userId = await resolveUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  // 404 rather than 403 for someone else's plan: never confirm that an id
  // belonging to another account exists.
  const owner = await plans.findOwner(id);
  if (owner !== userId) {
    return problem(404, "not found");
  }

  try {
    await storage.delete(id);
  } catch (error) {
    logger.error({ err: error, planId: id }, "plan object delete failed");
    return problem(502, "storage unavailable");
  }

  // `deleteOwned` re-checks ownership, so a concurrent change between the
  // lookup above and here can never delete another account's row.
  if (!(await plans.deleteOwned(id, userId))) {
    return problem(404, "not found");
  }

  // Sweep again now the row is gone. A replacement running concurrently can
  // have written its object after the delete above and had its own ownership
  // check pass before this line, and it would then be served by `/p/{id}`
  // with no row to own it. Every such write precedes this point, so this is
  // the one place that can catch it; ordinarily it removes nothing.
  await sweepOrphanedObject(storage, logger, id);

  return new Response(null, { status: 204 });
}
