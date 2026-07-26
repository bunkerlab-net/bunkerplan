import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { PlanRepo, PlanStorage } from "../services/types.ts";
import { planUrl } from "./plan-url.ts";
import { readUploadBody } from "./upload-body.ts";

/**
 * Replaces the document behind a plan the caller owns. The id, the public URL,
 * and the label are unchanged - only the bytes and the recorded size move.
 *
 * Object first, row second. A failed object write then changes nothing at all,
 * and `resize` matching on owner as well as id means a row that vanished under
 * a concurrent delete refuses the update, so the object just written is taken
 * back out again.
 *
 * That narrows the delete/replace race rather than closing it: a delete whose
 * object removal lands before this `put`, and whose row removal lands after
 * this `resize`, still leaves an object that `/p/{id}` serves with no row to
 * own it. Closing it needs the two paths to serialise on the row - a claim or
 * a version column - which is more machinery than a same-owner, same-plan,
 * same-instant collision is worth.
 */
export async function replacePlan(
  storage: PlanStorage,
  plans: PlanRepo,
  logger: Logger,
  request: Request,
  id: string,
  userId: string,
  config: Pick<Config, "maxUploadBytes" | "publicBaseUrl">,
): Promise<Response> {
  // 404 rather than 403 for someone else's plan: never confirm that an id
  // belonging to another account exists. Checked before the body is read, so
  // an upload for a plan the caller does not own is refused at the header.
  const notFound = () => Response.json({ error: "not found" }, { status: 404 });
  if ((await plans.findOwner(id)) !== userId) return notFound();

  const body = await readUploadBody(request, config.maxUploadBytes);
  if (body instanceof Response) return body;

  try {
    await storage.put(id, body);
  } catch (error) {
    logger.error({ err: error, planId: id }, "plan replacement failed");
    return Response.json({ error: "storage unavailable" }, { status: 502 });
  }

  if (!(await plans.resize(id, userId, body.byteLength))) {
    // The row went away between the two checks, so the object above now has no
    // owner. Nothing else can be holding it: ids are never reissued.
    await storage.delete(id).catch((error: unknown) => {
      logger.error({ err: error, planId: id }, "orphaned plan object");
    });
    return notFound();
  }

  return Response.json({ id, url: planUrl(config.publicBaseUrl, id) });
}
