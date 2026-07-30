import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { RateLimitRepo } from "../services/types.ts";
import { problem } from "./problem.ts";
import { unlockBucketKey } from "./share-auth.ts";

type UnlockRateConfig = Pick<
  Config,
  "clientIpHeader" | "secret" | "unlockRateMax" | "unlockRateWindowSec"
>;

/**
 * Configs that have already reported a missing trusted header.
 *
 * The warning below names one deployment-wide misconfiguration, and this route
 * takes no credential: repeating it per request lets a stranger turn a flood of
 * refused unlocks into a flood of log lines. Keyed on the config object, so it
 * is once per config per isolate - `getServices` memoises one config, which
 * makes that once per isolate in production, and a fresh one each time a new
 * isolate starts. A caller that builds its own config gets its own first
 * warning; a test wanting one has to pass a config no earlier call has seen.
 */
const reported = new WeakSet<UnlockRateConfig>();

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
  logger: Pick<Logger, "warn">,
): Promise<UnlockReservation> {
  const bucket = await bucketFor(config, request);
  if (bucket === null) {
    /*
     * Said out loud, because the symptom is silent: every redemption on this
     * deployment answers 429 and no reader can tell why. Configuration refuses
     * to load without naming a header, so reaching here means the proxy in
     * front is not sending the one it was told to trust.
     *
     * Once, per the note on `reported`. The refusal below is still every time.
     */
    if (!reported.has(config)) {
      reported.add(config);
      logger.warn(
        { header: config.clientIpHeader },
        "no trusted client address header, so every unlock is refused",
      );
    }
    /*
     * A minute, not the one second a spent budget gets. Nothing here refills:
     * the deployment refuses every unlock until an operator changes the proxy,
     * so "try again immediately" invites a client to retry forever against an
     * answer that cannot change.
     */
    return {
      refused: problem(429, "rate limit exceeded", { "retry-after": "60" }),
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
 * Rejects rather than swallowing, and the one caller catches it. That is on
 * purpose: losing a refund only leaves the budget one lower than it should be
 * - erring towards refusing, which is the safe direction - but it is also the
 * only sign that refunds are failing at all, and the caller is where the
 * logger is. Swallowing here would make the symptom silent and hand the reader
 * the same 200 either way.
 *
 * What must not happen is a redemption the reader completed turning into a
 * 500, and that is what the caller's `catch` in src/app.ts prevents.
 */
export async function refundUnlockAttempt(
  limits: RateLimitRepo,
  reservation: UnlockHold,
): Promise<void> {
  await limits.refund(reservation.bucket, reservation.windowStart);
}
