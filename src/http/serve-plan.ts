import { isPlanId } from "../ids.ts";
import type { PlanStorage } from "../services/types.ts";
import { PLAN_CSP } from "./security-headers.ts";

/**
 * `PLAN_CSP` is the single most important control in this design and MUST NOT
 * be removed. It lives in src/http/security-headers.ts because the entry
 * middleware pins the same constant onto every plan response, so a slip here
 * cannot reach a client - see the note there.
 */

// Short max-age rather than `immutable` because plans can be deleted, and
// replaced: a cache that already has one can serve the old document until the
// window is up.
const CACHE_CONTROL = "public, max-age=300, must-revalidate";

/**
 * Serves a published plan, or `null` when there is nothing to serve.
 *
 * `null` means "render the site's own 404 page" - the same page an unknown
 * route gets, so a plan that was deleted is indistinguishable from an id that
 * was never issued.
 */
export async function servePlan(
  storage: PlanStorage,
  request: Request,
  planId: string,
): Promise<Response | null> {
  // Only ids this app could have issued are routable. Anything else takes the
  // same path as a plan that is not there.
  if (!isPlanId(planId)) return null;

  // No auth, no database read: serving a plan is a single object read.
  const object = await storage.get(planId);
  if (object === null) return null;

  // One header set for both branches. A 304 that omitted these would not
  // merely lose them: the entry middleware fills in any security header a
  // response leaves absent, so the plan would inherit the *app* policy, which
  // has no `sandbox`. A cache told to update a stored response with the 304's
  // headers (RFC 9111 4.3.4) would then hold the plan under a policy that lets
  // it script the real origin.
  const headers: Record<string, string> = {
    "content-security-policy": PLAN_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": CACHE_CONTROL,
    etag: object.etag,
  };

  if (request.headers.get("if-none-match") === object.etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, {
    status: 200,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}
