import type { Config } from "../config.ts";
import type { RateLimitRepo } from "../services/types.ts";
import { problem } from "./problem.ts";

type UnlockRateConfig = Pick<
  Config,
  "clientIpHeader" | "unlockRateMax" | "unlockRateWindowSec"
>;

/**
 * Counts one share-code redemption against the calling address.
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
 * Null means proceed; otherwise the 429 to return.
 */
export async function checkUnlockRate(
  limits: RateLimitRepo,
  config: UnlockRateConfig,
  request: Request,
): Promise<Response | null> {
  const address = request.headers.get(config.clientIpHeader);
  if (address === null || address === "") {
    return problem(429, "rate limit exceeded", { "retry-after": "1" });
  }

  const limit = await limits.consume(
    address,
    config.unlockRateMax,
    config.unlockRateWindowSec,
  );
  if (limit.allowed) return null;

  return problem(429, "rate limit exceeded", {
    "retry-after": String(limit.retryAfter),
  });
}
