import type { AppAuth } from "../auth/instance.ts";

/**
 * An API key authorises PUT (upload and replace) and DELETE (remove) and
 * nothing else, so only the write routes accept one. Management routes -
 * listing plans, keys, and passkeys, relabelling, deleting the account - are
 * session-only. No session is ever minted
 * for a key (`enableSessionForAPIKeys` stays at its `false` default), so there
 * is exactly one code path per credential type.
 */
export async function resolveWriteUserId(
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
