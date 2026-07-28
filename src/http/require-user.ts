import type { AppAuth } from "../auth/instance.ts";

/**
 * The user an API key or a session acts for.
 *
 * A key acts for its owner on upload, replacement, delete, and reading a plan
 * that owner is allowed to read. Management routes - listing plans, keys, and
 * passkeys, relabelling, sharing, deleting the account - are session-only, so
 * they call `resolveSessionUserId` instead. No session is ever minted for a
 * key (`enableSessionForAPIKeys` stays at its `false` default), so there is
 * exactly one code path per credential type.
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
