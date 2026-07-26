import type { Config } from "../config.ts";
import type { RateLimitRepo } from "../services/types.ts";
import { problem } from "./problem.ts";

/**
 * Counts one upload against the caller's allowance. Null means proceed;
 * otherwise the 429 to return.
 *
 * Per user, not per credential: an API key and the dashboard session share one
 * allowance, and creating more keys does not buy more uploads. Creating a plan
 * and replacing one draw on the same allowance too - both write an object of
 * the same size, so charging only the first would leave the limit open to a
 * loop that replaces one plan forever.
 */
export async function checkUploadRate(
  limits: RateLimitRepo,
  config: Pick<Config, "uploadRateMax" | "uploadRateWindowSec">,
  userId: string,
): Promise<Response | null> {
  const limit = await limits.consume(
    userId,
    config.uploadRateMax,
    config.uploadRateWindowSec,
  );
  if (limit.allowed) return null;

  return problem(429, "rate limit exceeded", {
    "retry-after": String(limit.retryAfter),
  });
}
