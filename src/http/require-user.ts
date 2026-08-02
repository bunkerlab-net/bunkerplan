import type { AppAuth } from "../auth/instance.ts";

/**
 * The user an API key or a session acts for.
 *
 * A key acts for its owner on the whole plan API bar sharing: upload,
 * replacement, relabelling, delete, listing, and reading a plan that owner is
 * allowed to read. Every one of those handlers calls this itself - the router in
 * src/app.ts resolves nobody - so a route registered later cannot forget the
 * check and each handler's 401 is testable without a server.
 *
 * What stays session-only is handing out access - sharing, share codes, grants -
 * and those six handlers in src/http/plan-sharing.ts are the only routes that
 * call `resolveSessionUserId` directly; the other caller is this function, which
 * falls back to it. Managing keys and passkeys and deleting the account are
 * session-only too, but they are Better Auth's own routes under `/api/auth/*`
 * and never reach this module. No session is ever minted for a key
 * (`enableSessionForAPIKeys` stays at its `false` default), so there is exactly
 * one code path per credential type.
 */
export async function resolveUserId(
  auth: AppAuth,
  request: Request,
): Promise<string | null> {
  const key = request.headers.get("x-api-key");
  if (key !== null) {
    const result = await auth.api.verifyApiKey({ body: { key } });
    if (!result.valid || result.key === null) return null;
    // `referenceId`, not `userId` - the column was renamed in 1.6.x.
    return result.key.referenceId;
  }
  return await resolveSessionUserId(auth, request);
}

export async function resolveSessionUserId(
  auth: AppAuth,
  request: Request,
): Promise<string | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user.id ?? null;
}
