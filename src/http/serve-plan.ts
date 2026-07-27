import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import type { PlanRepo, PlanStorage } from "../services/types.ts";
import { resolvePlanAccess } from "./plan-access.ts";
import { PLAN_CSP } from "./security-headers.ts";

/**
 * `PLAN_CSP` is the single most important control in this design and MUST NOT
 * be removed. It lives in src/http/security-headers.ts because the entry
 * middleware pins the same constant onto every plan response, so a slip here
 * cannot reach a client - see the note there.
 */

// Short max-age rather than `immutable` because plans can be deleted, and
// replaced: a cache that already has one can serve the old document until the
// window is up. Only a public plan gets it - see below.
const CACHE_CONTROL = "public, max-age=300, must-revalidate";

/**
 * Serves a plan the visitor is allowed to read.
 *
 * `null` means "render the site's own 404 page" - the same page an unknown
 * route gets, so a plan that was deleted is indistinguishable from an id that
 * was never issued. The gate marker means the plan is there but this visitor
 * is not allowed it yet; the caller renders the gate page at 401, which is
 * load-bearing (see src/app.ts).
 *
 * Access is resolved before storage is touched, so an unauthorised visitor
 * costs one row read and never an object read.
 */
export async function servePlan(
  storage: PlanStorage,
  plans: PlanRepo,
  auth: AppAuth,
  config: Pick<Config, "secret" | "publicBaseUrl">,
  request: Request,
  planId: string,
): Promise<Response | { gate: true; hasCode: boolean } | null> {
  const access = await resolvePlanAccess(auth, plans, config, request, planId);
  if (access.kind === "missing") return null;
  if (access.kind === "gate") {
    return { gate: true, hasCode: access.hasCode };
  }

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
    etag: object.etag,
    // A private plan must never land in a shared cache, and its response
    // varies by the credential that opened the gate.
    ...(access.visibility === "public"
      ? { "cache-control": CACHE_CONTROL }
      : { "cache-control": "private, no-store", vary: "cookie" }),
  };

  // On the 304 branch too: a conditional request carrying `?code=` must still
  // leave the reader holding the cookie, or the parameter would be needed on
  // every subsequent request.
  if (access.setCookie !== undefined) headers["set-cookie"] = access.setCookie;

  if (request.headers.get("if-none-match") === object.etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, {
    status: 200,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}
