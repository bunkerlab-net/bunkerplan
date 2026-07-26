import type { PlanCreated } from "../api/schemas.ts";
import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import { newPlanId } from "../ids.ts";
import type { Logger } from "../log.ts";
import type {
  AccountClosingRepo,
  PlanRepo,
  PlanStorage,
  RateLimitRepo,
} from "../services/types.ts";
import { parsePlanLabel } from "./plan-label.ts";
import { planUrl } from "./plan-url.ts";
import { problem } from "./problem.ts";
import { resolveWriteUserId } from "./require-user.ts";
import { storeAndConfirm } from "./store-plan.ts";
import { readUploadBody } from "./upload-body.ts";
import { checkUploadRate } from "./upload-rate-limit.ts";

const MAX_ID_ATTEMPTS = 3;

export interface CreatePlanDeps {
  auth: AppAuth;
  config: Config;
  plans: PlanRepo;
  accountClosing: AccountClosingRepo;
  uploadRateLimits: RateLimitRepo;
  storage: PlanStorage;
  logger: Logger;
}

/**
 * Claims a free id, retrying only a collision. A full account is refused by
 * the same statement and must not be retried into.
 */
async function claimId(
  plans: PlanRepo,
  userId: string,
  label: string | null,
  size: number,
  limits: Pick<Config, "planIdLength" | "maxPlansPerUser">,
): Promise<string | "quota" | null> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const id = newPlanId(limits.planIdLength);
    const claimed = await plans.insert(
      { id, userId, label, size },
      limits.maxPlansPerUser,
    );
    if (claimed === "created") return id;
    if (claimed === "quota") return "quota";
  }
  return null;
}

export async function createPlan(
  deps: CreatePlanDeps,
  request: Request,
): Promise<Response> {
  const { auth, config, plans, accountClosing, uploadRateLimits, storage } =
    deps;

  const userId = await resolveWriteUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  const limited = await checkUploadRate(uploadRateLimits, config, userId);
  if (limited !== null) return limited;

  // Refused once deletion of this account has begun. Without this an upload
  // can land between the object sweep and the row cascade, and its object
  // outlives the row that owned it.
  if (await accountClosing.isOpen(userId)) {
    return problem(409, "account is being deleted");
  }

  // A label is optional metadata, so a bad one is rejected before the body is
  // read rather than after a large upload has already been accepted.
  const parsed = parsePlanLabel(new URL(request.url).searchParams.get("label"));
  if (!parsed.ok) return problem(400, parsed.reason);

  const body = await readUploadBody(request, config.maxUploadBytes);
  if (body instanceof Response) return body;

  // Row first, object second. The public GET never consults the database, so an
  // object with no row would be served forever with no owner and no way to
  // delete it. A row with no object is merely a 404 its owner can clean up.
  const id = await claimId(
    plans,
    userId,
    parsed.label,
    body.byteLength,
    config,
  );
  const full = `plan limit reached (${config.maxPlansPerUser}); delete one first`;
  if (id === "quota") return problem(409, full);
  if (id === null) return problem(500, "could not allocate a plan id");

  const failure = await storeAndConfirm(
    { storage, plans, accountClosing, logger: deps.logger },
    id,
    userId,
    body,
  );
  if (failure === "storage-unavailable") {
    return problem(502, "storage unavailable");
  }
  if (failure === "withdrawn") return problem(404, "not found");

  const url = planUrl(config.publicBaseUrl, id);
  return Response.json({ id, url, label: parsed.label } satisfies PlanCreated, {
    status: 201,
    headers: { location: url },
  });
}
