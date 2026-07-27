import { constantTimeEqual } from "better-auth/crypto";
import { parseSigned, serializeSigned } from "hono/utils/cookie";
import type { Config } from "../config.ts";

/**
 * The share code: how it is stored, how it is compared, and the cookie that
 * remembers a successful comparison.
 *
 * Nothing here holds state. A code is stored only as a SHA-256 digest, and the
 * cookie that stands in for it is a signed statement binding the plan and the
 * digest that was current when it was issued - so rotating a code revokes
 * every outstanding cookie with no column to sweep and no list to keep.
 */

/** Twelve hours: long enough for a reading session, short enough to expire. */
export const SHARE_COOKIE_TTL_SEC = 43_200;

/**
 * Domain separation. `config.secret` is Better Auth's signing key; deriving a
 * distinct one here means a share cookie can never be confused for, or forged
 * from, anything Better Auth signs.
 */
const COOKIE_KEY_SUFFIX = "bunkerplan-share-cookie-v1";

const encoder = new TextEncoder();

/** Lowercase hex SHA-256. The stored form of a share code. */
export async function hashShareCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(code));
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * True when `code` matches the stored digest.
 *
 * Every comparison of a share-code digest goes through here, so no call site
 * can reintroduce `===` - which exits at the first differing character and
 * leaks the stored digest one character at a time. At the 16-character floor
 * that digest is a ~95-bit preimage and useless on its own, so this is hygiene
 * rather than the load-bearing control; it is what makes the guarantee hold at
 * every length rather than only at the floor.
 */
export async function shareCodeMatches(
  code: string,
  storedHash: string,
): Promise<boolean> {
  return constantTimeEqual(await hashShareCode(code), storedHash);
}

/** Path-scoped, so a browser only sends it for the plan it unlocks. */
export function shareCookieName(planId: string): string {
  return `bkp_share_${planId}`;
}

type ShareCookieConfig = Pick<Config, "secret" | "publicBaseUrl">;

function cookieSecret(secret: string): string {
  return `${secret}:${COOKIE_KEY_SUFFIX}`;
}

/** A `Set-Cookie` value carrying proof that this code was presented. */
export async function mintShareCookie(
  config: ShareCookieConfig,
  planId: string,
  shareCodeHash: string,
  now: number,
): Promise<string> {
  return await serializeSigned(
    shareCookieName(planId),
    // The signed statement. Binding the *current* hash is what makes rotation
    // revoke every outstanding cookie; binding the plan id stops a cookie
    // being renamed onto another plan.
    `${planId}:${shareCodeHash}:${now + SHARE_COOKIE_TTL_SEC * 1000}`,
    cookieSecret(config.secret),
    {
      // Scoped to the one plan, so a reader carrying several codes sends only
      // the one that applies.
      path: `/p/${planId}`,
      httpOnly: true,
      // Not `strict`: a share link is clicked from chat or mail, and `strict`
      // drops the cookie on exactly that cross-site top-level navigation.
      sameSite: "lax",
      // From the configured base URL rather than the request `Host`, for the
      // reason spelled out in src/app.ts - and unconditional `Secure` would
      // break http development.
      secure: config.publicBaseUrl.startsWith("https:"),
      maxAge: SHARE_COOKIE_TTL_SEC,
    },
  );
}

/**
 * True when the cookie is signed by us, unexpired, and bound to this exact
 * plan and this exact code digest.
 *
 * Returns false rather than throwing on every failure - a missing header, an
 * absent cookie, a bad signature, a malformed payload, a mismatched plan or
 * hash, or an expiry - because all of them mean the same thing to the caller.
 */
export async function verifyShareCookie(
  secret: string,
  planId: string,
  shareCodeHash: string,
  cookieHeader: string | null,
  now: number,
): Promise<boolean> {
  if (cookieHeader === null) return false;
  const name = shareCookieName(planId);
  let signed: string | false | undefined;
  try {
    signed = (await parseSigned(cookieHeader, cookieSecret(secret), name))[
      name
    ];
  } catch {
    return false;
  }
  if (typeof signed !== "string") return false;

  const parts = signed.split(":");
  if (parts.length !== 3) return false;
  const [cookiePlanId, cookieHash, expiresAt] = parts as [
    string,
    string,
    string,
  ];
  if (cookiePlanId !== planId) return false;
  if (!constantTimeEqual(cookieHash, shareCodeHash)) return false;

  const expiresAtMs = Number(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > now;
}
