import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { PlanRepo, PlanStorage } from "../services/types.ts";
import { planUrl } from "./plan-url.ts";
import { readUploadBody } from "./upload-body.ts";

/**
 * Replaces the document behind a plan the caller owns. The id, the public URL,
 * and the label are unchanged - only the bytes and the recorded size move.
 *
 * Row first, object second, matching the create path. `resize` is the
 * authorisation: it matches on owner as well as id, so the object write can
 * only ever land on the caller's own plan. A failed write leaves the row's
 * size ahead of the served bytes, which a retry fixes; the earlier document is
 * still intact.
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
  // belonging to another account exists.
  const notFound = () => Response.json({ error: "not found" }, { status: 404 });
  if ((await plans.findOwner(id)) !== userId) return notFound();

  const body = await readUploadBody(request, config.maxUploadBytes);
  if (body instanceof Response) return body;

  if (!(await plans.resize(id, userId, body.byteLength))) return notFound();

  try {
    await storage.put(id, body);
  } catch (error) {
    logger.error({ err: error, planId: id }, "plan replacement failed");
    return Response.json({ error: "storage unavailable" }, { status: 502 });
  }

  return Response.json({ id, url: planUrl(config.publicBaseUrl, id) });
}
