import type { PlanList } from "../api/schemas.ts";
import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import { PLAN_PAGE_SIZE } from "../limits.ts";
import type { PlanRepo } from "../services/types.ts";
import { planUrl } from "./plan-url.ts";
import { problem } from "./problem.ts";
import { resolveUserId } from "./require-user.ts";

export async function listPlans(
  auth: AppAuth,
  plans: PlanRepo,
  config: Pick<Config, "publicBaseUrl">,
  request: Request,
): Promise<Response> {
  // A key or a session, like the rest of the plan API. Enumeration hands a
  // leaked key ids it did not have, but every one of those plans was already
  // readable, replaceable, and deletable by it - so this widens what a key
  // knows, not what it can do, and a client that has no cookie is otherwise
  // blind to plans it did not just upload. Unmetered, like the other reads;
  // what bounds one call is the page size below.
  const userId = await resolveUserId(auth, request);
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
