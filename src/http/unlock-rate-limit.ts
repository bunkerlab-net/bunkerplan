import type { Config } from "../config.ts";
import type { RateLimitRepo } from "../services/types.ts";
import { problem } from "./problem.ts";
import { unlockBucketKey } from "./share-auth.ts";

type UnlockRateConfig = Pick<
  Config,
  "clientIpHeader" | "secret" | "unlockRateMax" | "unlockRateWindowSec"
>;

/**
 * The share-code redemption budget for the calling address.
 *
 * Two halves on purpose. `checkUnlockRate` gates without spending, and
 * `chargeUnlockAttempt` spends only once the attempt is known to have failed -
 * so a correct code costs nothing. Charging every attempt made a link shared
 * with a room of people behind one egress address lock them out of a plan they
 * had been given, at the 31st opening in a minute. What this rations is
 * guessing, and a guess is a failure by definition.
 *
 * Keyed on the address alone, never the plan. Per-plan is the one thing an
 * anonymous limiter must not do: the plan id travels in the share link, so
 * anybody holding that link could spend the allowance and lock every other
 * reader out of a plan they do not own. An address spends only its own.
 *
 * The header is the one this deployment already trusts for Better Auth's
 * limiter, and configuration refuses to load off Cloudflare without naming it,
 * so an unidentifiable caller means the proxy in front of this is not the one
 * the operator described. Refusing is the safe reading of that: the alternative
 * is one shared bucket for every caller, which is the lockout above.
 *
 * The bucket stored is a keyed digest of the address, not the address - see
 * `unlockBucketKey`. That changes nothing about the counting.
 */
async function bucketFor(
  config: UnlockRateConfig,
  request: Request,
): Promise<string | null> {
  const address = request.headers.get(config.clientIpHeader);
  if (address === null || address === "") return null;
  return await unlockBucketKey(config.secret, address);
}

/**
 * Either the 429 to return, or the bucket the attempt will be charged against.
 *
 * The key rather than a bare "proceed": it is an HMAC of the caller's address,
 * and handing it back means the charge cannot compute a second one. Same bucket
 * by construction rather than by two call sites agreeing.
 */
export type UnlockBudget =
  | { readonly refused: Response }
  | { readonly bucket: string };

/** Spends nothing. */
export async function checkUnlockRate(
  limits: RateLimitRepo,
  config: UnlockRateConfig,
  request: Request,
): Promise<UnlockBudget> {
  const bucket = await bucketFor(config, request);
  if (bucket === null) {
    return {
      refused: problem(429, "rate limit exceeded", { "retry-after": "1" }),
    };
  }

  const limit = await limits.peek(
    bucket,
    config.unlockRateMax,
    config.unlockRateWindowSec,
  );
  if (limit.allowed) return { bucket };

  return {
    refused: problem(429, "rate limit exceeded", {
      "retry-after": String(limit.retryAfter),
    }),
  };
}

/**
 * Charges one refused redemption, against the bucket the gate read.
 *
 * Called after the attempt and only when it did not grant access. A write
 * failure propagates: catching it would leave the limiter silently not counting.
 */
export async function chargeUnlockAttempt(
  limits: RateLimitRepo,
  config: UnlockRateConfig,
  bucket: string,
): Promise<void> {
  await limits.consume(
    bucket,
    config.unlockRateMax,
    config.unlockRateWindowSec,
  );
}
