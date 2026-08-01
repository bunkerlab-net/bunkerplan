import type { PlanRelabelled } from "../api/schemas.ts";
import type { AppAuth } from "../auth/instance.ts";
import { MAX_LABEL_BODY_BYTES } from "../limits.ts";
import type { PlanRepo } from "../services/types.ts";
import { readJsonBody } from "./bounded-body.ts";
import { parsePlanLabel } from "./plan-label.ts";
import { problem } from "./problem.ts";
import { resolveUserId } from "./require-user.ts";

/**
 * Relabels a plan the caller owns. Nothing outside the row changes: the object
 * key, the public URL, and the served document are all untouched.
 *
 * `relabel` re-checks ownership in its own predicate, so no separate lookup is
 * needed and there is no window in which another account's row could match.
 * A miss is a 404 rather than a 403 - never confirm that someone else's id
 * exists.
 *
 * The caller is resolved here rather than in the router, so a route registered
 * later cannot forget it - the same reason the sharing handlers do their own.
 * A key or a session, like PUT and DELETE beside it: a caller that may replace
 * the document or destroy the plan outright is not one to refuse a rename over,
 * and `?label=` already lets a key name a plan at upload.
 *
 * Unmetered, as DELETE is: the upload allowance covers upload and replace only.
 * What bounds this one is `MAX_LABEL_BODY_BYTES` - a label is capped at
 * `MAX_PLAN_LABEL_LENGTH` characters, so the document carrying one has no
 * business being large, and without the bound this endpoint would parse
 * whatever it is sent before the cap was ever consulted.
 *
 * Two dependencies, so they arrive positionally - the same shape `listPlans`,
 * `getPlanSharing`, and `servePlan` have. The named-object convention next
 * door in `replacePlan` and `deletePlan` starts where the list gets long
 * enough to misread at a call site; adopting it here alone would make this
 * the odd one out among the handlers it actually resembles.
 */
export async function relabelPlan(
  auth: AppAuth,
  plans: PlanRepo,
  request: Request,
  id: string,
): Promise<Response> {
  const userId = await resolveUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  const read = await readJsonBody(request, MAX_LABEL_BODY_BYTES);
  if (!read.ok) return read.response;
  const { body } = read;

  if (typeof body !== "object" || body === null || !("label" in body)) {
    return problem(400, "label is required");
  }

  const raw = body.label;
  if (raw !== null && typeof raw !== "string") {
    return problem(400, "label must be a string or null");
  }

  const parsed = parsePlanLabel(raw);
  if (!parsed.ok) {
    return problem(400, parsed.reason);
  }

  if (!(await plans.relabel(id, userId, parsed.label))) {
    return problem(404, "not found");
  }

  return Response.json({ id, label: parsed.label } satisfies PlanRelabelled);
}
