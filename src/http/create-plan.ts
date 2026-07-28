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
import {
  applyGrants,
  type GrantOutcomes,
  parseAccountList,
} from "./account-list.ts";
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

/** What survived `admit`: the caller, and the parsed query parameters. */
interface Admitted {
  userId: string;
  label: string | null;
  requested: UploadVisibility;
  /** Accounts named by `?grants=`; empty when the parameter was absent. */
  accounts: string[];
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
 * that `?label=`, `?visibility=`, and `?grants=` are all usable.
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

  // Absent means "share with nobody", which is not the same as present and
  // empty - `?grants=` with nothing after it is a mistake worth reporting.
  const raw = query.get("grants");
  let accounts: string[] = [];
  if (raw !== null) {
    const list = parseAccountList(raw);
    if ("error" in list) return problem(400, list.error);
    accounts = list.accounts;
  }

  return {
    userId,
    label: parsed.label,
    requested: wanted.requested,
    accounts,
  };
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
  grants: GrantOutcomes | null,
): Response {
  return Response.json(
    {
      id,
      url,
      label,
      // The only time the plaintext is ever returned; there is no way to read
      // it back. The caller composes `${url}?code=${code}`.
      ...(code === null ? {} : { code }),
      // Only when `?grants=` asked for them, so an upload that named
      // nobody does not carry three empty arrays.
      ...(grants === null ? {} : grants),
    } satisfies PlanCreated,
    {
      status: 201,
      headers: {
        location: url,
        // `?visibility=code` puts that code in this body, the same secret the
        // rotate route protects, and `?grants=` puts account names in it.
        // Unconditional rather than only on those branches, so the upload
        // paths cannot answer differently.
        "cache-control": "no-store",
      },
    },
  );
}

/** What the grant step decided, once the plan is already stored. */
type UploadGrants =
  | { grants: GrantOutcomes | null }
  /** The plan was deleted between storing it and granting. */
  | { gone: true };

/**
 * Applies `?grants=` to a plan that is already stored, and never throws.
 *
 * The row and the object are durable by the time this runs, so a raised error
 * would answer 500 for a plan that exists: the caller could not tell whether
 * to retry the upload, and retrying would store it twice. `applyGrants`
 * reports a per-account failure rather than raising; the catch here covers
 * the ownership read it does first, and the accounts come back under
 * `failed` so every one of them still has an outcome.
 *
 * `gone` is the other thing that read can mean. "Not yours" is unreachable on
 * a plan this request just made, so it says the plan was deleted underneath -
 * the same condition `storeAndConfirm` reports as `withdrawn`, and it gets
 * the same 404. A 201 there would hand back a `Location` for a plan that no
 * longer exists.
 */
async function grantOnUpload(
  deps: Pick<CreatePlanDeps, "plans" | "logger">,
  planId: string,
  userId: string,
  accounts: string[],
): Promise<UploadGrants> {
  if (accounts.length === 0) return { grants: null };
  try {
    const outcomes = await applyGrants(deps.plans, planId, userId, accounts);
    if (outcomes !== null) return { grants: outcomes };
    deps.logger.warn({ planId }, "plan vanished before its grants applied");
    return { gone: true };
  } catch (cause) {
    deps.logger.warn({ err: cause, planId }, "grants failed on upload");
    return { grants: { granted: [], unknown: [], failed: accounts } };
  }
}

/**
 * Writes the object and confirms the row survived it, as a response or null
 * to carry on. Split out only so `createPlan` stays readable; the ordering it
 * protects is documented on `storeAndConfirm`.
 */
async function store(
  deps: CreatePlanDeps,
  id: string,
  userId: string,
  body: Uint8Array,
): Promise<Response | null> {
  const { storage, plans, accountClosing } = deps;
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
  return null;
}

export async function createPlan(
  deps: CreatePlanDeps,
  request: Request,
): Promise<Response> {
  const { config, plans } = deps;

  const admitted = await admit(deps, request);
  if (admitted instanceof Response) return admitted;
  const { userId, label, requested, accounts } = admitted;

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

  const stored = await store(deps, id, userId, body);
  if (stored !== null) return stored;

  const applied = await grantOnUpload(deps, id, userId, accounts);
  // Deleted underneath this request, so the same answer the earlier check
  // gives - handing back a Location for a plan that has gone would be worse
  // than saying so.
  if ("gone" in applied) return problem(404, "not found");

  return created(
    planUrl(config.publicBaseUrl, id),
    id,
    label,
    code,
    applied.grants,
  );
}
