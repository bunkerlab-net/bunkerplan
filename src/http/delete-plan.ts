import type { Logger } from "../log.ts";
import type { PlanRepo, PlanStorage } from "../services/types.ts";

/**
 * Object first, row second - the mirror of the upload path.
 *
 * The public GET never consults the database, so an object whose row is gone
 * would be served forever with no owner and no way to remove it. Deleting the
 * object first means a storage failure loses nothing: the row is still there,
 * the plan is still listed, and the caller can retry. A database failure after
 * a successful object delete leaves only a stale row, which lists a plan whose
 * URL 404s and which the owner can retry away (object deletes are idempotent).
 */
export async function deletePlan(
  storage: PlanStorage,
  plans: PlanRepo,
  logger: Logger,
  id: string,
  userId: string,
): Promise<Response> {
  // 404 rather than 403 for someone else's plan: never confirm that an id
  // belonging to another account exists.
  const owner = await plans.findOwner(id);
  if (owner !== userId) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  try {
    await storage.delete(id);
  } catch (error) {
    logger.error({ err: error, planId: id }, "plan object delete failed");
    return Response.json({ error: "storage unavailable" }, { status: 502 });
  }

  // `deleteOwned` re-checks ownership, so a concurrent change between the
  // lookup above and here can never delete another account's row.
  if (!(await plans.deleteOwned(id, userId))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Sweep again now the row is gone. A replacement running concurrently can
  // have written its object after the delete above and had its own ownership
  // check pass before this line, and it would then be served by `/p/{id}`
  // with no row to own it. Every such write precedes this point, so this is
  // the one place that can catch it; ordinarily it removes nothing.
  await storage.delete(id).catch((error: unknown) => {
    logger.error({ err: error, planId: id }, "orphaned plan object");
  });

  return new Response(null, { status: 204 });
}
