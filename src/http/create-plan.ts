import type { PlanCreated } from "../api/schemas.ts";
import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import { newPlanId, newShareCode } from "../ids.ts";
import type { Logger } from "../log.ts";
import type {
  AccountClosingRepo,
  PlanRepo,
  PlanStorage,
  PlanVisibility,
  RateLimitRepo,
} from "../services/types.ts";
import { parsePlanLabel } from "./plan-label.ts";
import { planUrl } from "./plan-url.ts";
import {
  parseUploadVisibility,
  storedVisibility,
  type UploadVisibility,
} from "./plan-visibility.ts";
import { problem } from "./problem.ts";
import { resolveUserId } from "./require-user.ts";
import { hashShareCode } from "./share-auth.ts";
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

/** What survived `admit`: the caller, and the two parsed query parameters. */
interface Admitted {
  userId: string;
  label: string | null;
  requested: UploadVisibility;
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
  visibility: PlanVisibility,
  shareCodeHash: string | null,
  limits: Pick<Config, "planIdLength" | "maxPlansPerUser">,
): Promise<string | "quota" | null> {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const id = newPlanId(limits.planIdLength);
    const claimed = await plans.insert(
      { id, userId, label, size, visibility, shareCodeHash },
      limits.maxPlansPerUser,
    );
    if (claimed === "created") return id;
    if (claimed === "quota") return "quota";
  }
  return null;
}

/**
 * Everything that must hold before a byte of the body is read: the caller's
 * identity, their allowance, that their account is not being deleted, and
 * that the two query parameters are usable.
 *
 * Ordered this way so a large upload is never accepted and then thrown away
 * over a typo in `?visibility=`.
 */
async function admit(
  deps: CreatePlanDeps,
  request: Request,
): Promise<Admitted | Response> {
  const { auth, config, accountClosing, uploadRateLimits } = deps;

  const userId = await resolveUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  const limited = await checkUploadRate(uploadRateLimits, config, userId);
  if (limited !== null) return limited;

  // Refused once deletion of this account has begun. Without this an upload
  // can land between the object sweep and the row cascade, and its object
  // outlives the row that owned it.
  if (await accountClosing.isOpen(userId)) {
    return problem(409, "account is being deleted");
  }

  const query = new URL(request.url).searchParams;
  const parsed = parsePlanLabel(query.get("label"));
  if (!parsed.ok) return problem(400, parsed.reason);
  const wanted = parseUploadVisibility(query.get("visibility"));
  if (!wanted.ok) return problem(400, wanted.reason);

  return { userId, label: parsed.label, requested: wanted.requested };
}

/**
 * The 201, which is the only response in the app that can carry a plaintext
 * share code.
 */
function created(
  url: string,
  id: string,
  label: string | null,
  code: string | null,
): Response {
  return Response.json(
    {
      id,
      url,
      label,
      // The only time the plaintext is ever returned; there is no way to read
      // it back. The caller composes `${url}?code=${code}`.
      ...(code === null ? {} : { code }),
    } satisfies PlanCreated,
    {
      status: 201,
      headers: {
        location: url,
        // `?visibility=code` puts that code in this body, the same secret the
        // rotate route protects. Unconditional rather than only on that
        // branch, so the two upload paths cannot answer differently.
        "cache-control": "no-store",
      },
    },
  );
}

export async function createPlan(
  deps: CreatePlanDeps,
  request: Request,
): Promise<Response> {
  const { config, plans, accountClosing, storage } = deps;

  const admitted = await admit(deps, request);
  if (admitted instanceof Response) return admitted;
  const { userId, label, requested } = admitted;

  const body = await readUploadBody(request, config.maxUploadBytes);
  if (body instanceof Response) return body;

  // Minted once, outside the retry loop below: a collision re-rolls the id,
  // never the code. The hash travels in the claiming insert rather than a
  // follow-up update, because a second statement that failed would hand the
  // caller a code the row does not carry.
  const code =
    requested === "code" ? newShareCode(config.shareCodeLength) : null;

  // Row first, object second. An object with no row would be served with no
  // owner and no way to delete it. A row with no object is merely a 404 its
  // owner can clean up.
  const id = await claimId(
    plans,
    userId,
    label,
    body.byteLength,
    storedVisibility(requested),
    code === null ? null : await hashShareCode(code),
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

  return created(planUrl(config.publicBaseUrl, id), id, label, code);
}
