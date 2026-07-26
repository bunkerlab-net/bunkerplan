import type { ErrorBody } from "../api/schemas.ts";

/**
 * The one shape every failing `/api/*` response carries, typed against the
 * schema the published document is built from, so a handler cannot invent a
 * second error shape without failing `tsc`.
 */
export function problem(
  status: number,
  error: string,
  headers?: HeadersInit,
): Response {
  const body: ErrorBody = { error };
  return Response.json(body, { status, ...(headers ? { headers } : {}) });
}
