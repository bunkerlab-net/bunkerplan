import type { PlanList } from "../api/schemas.ts";
import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import { PLAN_PAGE_SIZE, type PlanRepo } from "../services/types.ts";
import { planUrl } from "./plan-url.ts";
import { problem } from "./problem.ts";
import { resolveSessionUserId } from "./require-user.ts";

export async function listPlans(
  auth: AppAuth,
  plans: PlanRepo,
  config: Pick<Config, "publicBaseUrl">,
  request: Request,
): Promise<Response> {
  // Session-only. Not because a key cannot read - it can, one plan at a time
  // through the read gate - but because enumerating an account's plans is a
  // dashboard capability rather than a per-plan one.
  const userId = await resolveSessionUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  // Paged by a fixed size, never by the quota: lowering the quota does not
  // remove rows written under the old one, and paging by it would hide them.
  // `truncated` says so rather than silently returning a short list.
  const rows = await plans.listByUser(userId, PLAN_PAGE_SIZE + 1);
  const page = rows.slice(0, PLAN_PAGE_SIZE);
  return Response.json({
    plans: page.map((row) => ({
      id: row.id,
      url: planUrl(config.publicBaseUrl, row.id),
      label: row.label,
      size: row.size,
      createdAt: row.createdAt.toISOString(),
      visibility: row.visibility,
      hasShareCode: row.hasShareCode,
      hasGrants: row.hasGrants,
    })),
    truncated: rows.length > PLAN_PAGE_SIZE,
  } satisfies PlanList);
}
