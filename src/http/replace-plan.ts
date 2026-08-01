import type { PlanReplaced } from "../api/schemas.ts";
import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type {
  PlanRepo,
  PlanStorage,
  RateLimitRepo,
} from "../services/types.ts";
import { planUrl } from "./plan-url.ts";
import { problem } from "./problem.ts";
import { resolveUserId } from "./require-user.ts";
import { sweepOrphanedObject } from "./store-plan.ts";
import { readUploadBody } from "./upload-body.ts";
import { checkUploadRate } from "./upload-rate-limit.ts";

/** Eight things, so they arrive named - as `CreatePlanDeps` does next door. */
export interface ReplacePlanDeps {
  auth: AppAuth;
  config: Pick<
    Config,
    "maxUploadBytes" | "publicBaseUrl" | "uploadRateMax" | "uploadRateWindowSec"
  >;
  plans: PlanRepo;
  uploadRateLimits: RateLimitRepo;
  storage: PlanStorage;
  logger: Logger;
}

/**
 * Replaces the document behind a plan the caller owns. The id, the public URL,
 * and the label are unchanged - only the bytes and the recorded size move.
 *
 * Object first, row second. A failed object write then changes nothing at all,
 * and `resize` matching on owner as well as id means a row that vanished under
 * a concurrent delete refuses the update, so the object just written is taken
 * back out again. The delete path sweeps once more after dropping the row,
 * which catches a write that landed inside its own window.
 *
 * The caller and their allowance are resolved here rather than in the router,
 * so a route registered later cannot forget either - the same reason
 * `createPlan` admits its own callers. Replacing draws on the upload allowance
 * because it writes an object of the same size; charging only the first upload
 * would leave the limit open to a loop that replaces one plan forever.
 */
export async function replacePlan(
  deps: ReplacePlanDeps,
  request: Request,
  id: string,
): Promise<Response> {
  const { auth, config, logger, plans, storage, uploadRateLimits } = deps;

  const userId = await resolveUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  const limited = await checkUploadRate(uploadRateLimits, config, userId);
  if (limited !== null) return limited;

  // 404 rather than 403 for someone else's plan: never confirm that an id
  // belonging to another account exists. Checked before the body is read, so
  // an upload for a plan the caller does not own is refused at the header.
  const notFound = () => problem(404, "not found");
  if ((await plans.findOwner(id)) !== userId) return notFound();

  const body = await readUploadBody(request, config.maxUploadBytes);
  if (body instanceof Response) return body;

  try {
    await storage.put(id, body);
  } catch (error) {
    logger.error({ err: error, planId: id }, "plan replacement failed");
    return problem(502, "storage unavailable");
  }

  if (!(await plans.resize(id, userId, body.byteLength))) {
    // The row went away between the two checks, so the object above now has no
    // owner. Nothing else can be holding it: ids are never reissued.
    await sweepOrphanedObject(storage, logger, id);
    return notFound();
  }

  return Response.json({
    id,
    url: planUrl(config.publicBaseUrl, id),
  } satisfies PlanReplaced);
}
