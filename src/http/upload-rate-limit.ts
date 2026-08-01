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
 *
 * Charged per attempt, and never given back - unlike the unlock bucket, which
 * hands out a hold and refunds it. The difference is what each limit is for.
 * The unlock one rations guessing, so a correct code must not spend it; this
 * one rations work, and an attempt that was admitted has already cost the
 * deployment the body read and whatever followed. A refund on failure would
 * also be a free retry loop for anyone able to make an upload fail, and
 * several of the failures are the caller's to cause - an oversized body, a
 * document that is not standalone - both of which are refused after this runs.
 *
 * The cost is that a failure which is not the caller's - the 503 when a claim
 * times out, the 502 when storage is down - still spends a count. Giving those
 * back means `consume` handing out a hold here as it does for unlocks, and
 * every caller carrying it to every exit; worth doing if contention ever turns
 * those 503s into 429s in practice, and not before.
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
