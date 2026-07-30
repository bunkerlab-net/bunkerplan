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
 * Two halves on purpose. `reserveUnlockAttempt` takes a count before the code is
 * compared, and `refundUnlockAttempt` gives it back once the attempt turns out
 * to have been a redemption - so a correct code costs nothing and a failed guess
 * is what the budget spends on. Charging every attempt made a link shared with a
 * room of people behind one egress address lock them out of a plan they had been
 * given, at the 31st opening in a minute. What this rations is guessing, and a
 * guess is a failure by definition.
 *
 * Spending first and refunding after is the order that works, not the reverse;
 * see `reserveUnlockAttempt` for why reading the budget first bounds nothing.
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
 * The bucket and the window a reservation was charged in, so the refund can
 * name both: it must give the count back to the window that took it and nowhere
 * else.
 */
export interface UnlockHold {
  readonly bucket: string;
  readonly windowStart: number;
}

/** Either the 429 to return, or the reservation the attempt now holds. */
export type UnlockReservation = { readonly refused: Response } | UnlockHold;

/**
 * Takes one count before the code is compared.
 *
 * Spending first is what makes the limit real. Reading the budget without
 * spending it bounds nothing: any number of concurrent callers pass such a read
 * before one write lands, so a parallel guesser would face no limit at all.
 *
 * A correct code gets its count back - see `refundUnlockAttempt` - so the budget
 * still rations only guessing. What this order costs is that simultaneous
 * openings of one shared link hold the budget down while they are in flight, and
 * one of them can see a refusal it would not have seen a moment later. A retry
 * works; a limiter a parallel caller walks through does not.
 */
export async function reserveUnlockAttempt(
  limits: RateLimitRepo,
  config: UnlockRateConfig,
  request: Request,
): Promise<UnlockReservation> {
  const bucket = await bucketFor(config, request);
  if (bucket === null) {
    return {
      refused: problem(429, "rate limit exceeded", { "retry-after": "1" }),
    };
  }

  const limit = await limits.consume(
    bucket,
    config.unlockRateMax,
    config.unlockRateWindowSec,
  );
  if (limit.allowed) return { bucket, windowStart: limit.windowStart };

  return {
    refused: problem(429, "rate limit exceeded", {
      "retry-after": String(limit.retryAfter),
    }),
  };
}

/**
 * Gives the reservation back, for an attempt that turned out to be a redemption.
 *
 * A failure here is swallowed by the caller rather than surfaced: the count was
 * already taken, so losing the refund only leaves the budget one lower than it
 * should be. That errs towards refusing, which is the safe direction, and it
 * must not turn a redemption the reader completed into a 500.
 */
export async function refundUnlockAttempt(
  limits: RateLimitRepo,
  reservation: UnlockHold,
): Promise<void> {
  await limits.refund(reservation.bucket, reservation.windowStart);
}
