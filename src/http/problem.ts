import type { ErrorBody } from "../api/schemas.ts";

/**
 * The one shape a failing plan-API response carries, typed against the schema
 * the published document is built from, so a handler cannot invent a second
 * error shape without failing `tsc`.
 *
 * Two routes outside that set answer differently on purpose. `/api/auth/*`
 * belongs to Better Auth, which shapes its own failures (`{ message, code }`)
 * - the published document does not describe that prefix either. `/healthz`
 * reports `Health` on both 200 and 503, because a failed probe is a readiness
 * result rather than a request error.
 */
export function problem(
  status: number,
  error: string,
  headers?: HeadersInit,
): Response {
  const body: ErrorBody = { error };
  return Response.json(body, { status, ...(headers ? { headers } : {}) });
}
