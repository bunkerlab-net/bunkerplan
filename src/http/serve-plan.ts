import type { AppAuth } from "../auth/instance.ts";
import type { PlanRepo, PlanStorage } from "../services/types.ts";
import { resolvePlanAccess } from "./plan-access.ts";
import { PLAN_CSP, PLAN_DOCUMENT_HEADER } from "./security-headers.ts";
import type { ShareCookieConfig } from "./share-auth.ts";

/**
 * `PLAN_CSP` is the single most important control in this design and MUST NOT
 * be removed. It lives in src/http/security-headers.ts because the entry
 * middleware pins the same constant onto every plan response, so a slip here
 * cannot reach a client - see the note there.
 */

// `no-cache` means "may be stored, but revalidate before every use" - not
// "do not cache". Every read therefore comes back through `resolvePlanAccess`
// and the ETag below, so a plan that is deleted, replaced, or flipped to
// private stops being served the moment it changes; a validated 304 still
// costs the reader no body. A freshness window instead of this - the previous
// `max-age=300` - let a shared cache keep handing out a plan for five minutes
// after its owner made it private, which is a hole in the one control this
// feature exists to provide. Only a public plan gets even this - see below.
const CACHE_CONTROL = "public, no-cache";

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
  config: ShareCookieConfig,
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
    // The marker rides in the same literal as the policy so the two cannot be
    // set apart: `applySecurityHeaders` strips it and overwrites the policy
    // with the same constant on every response that carries it. This is the
    // only place that sets it - the gate and the 404 are the app's own HTML.
    [PLAN_DOCUMENT_HEADER]: "1",
    "content-security-policy": PLAN_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    etag: object.etag,
    // A private plan must never land in a shared cache, and its response
    // varies by every credential that can open the gate - the unlock cookie
    // and a session both ride in `cookie`, an API client sends `x-api-key`.
    // `?code=` needs no mention: a query string is already part of the cache
    // key.
    ...(access.visibility === "public"
      ? { "cache-control": CACHE_CONTROL }
      : { "cache-control": "private, no-store", vary: "cookie, x-api-key" }),
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
