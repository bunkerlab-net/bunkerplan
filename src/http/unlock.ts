import type { Logger } from "../log.ts";
import type { PlanRepo, RateLimitRepo } from "../services/types.ts";
import { unlockPlan } from "./plan-access.ts";
import type { ShareCookieConfig } from "./share-auth.ts";
import {
  refundUnlockAttempt,
  reserveUnlockAttempt,
  type UnlockRateConfig,
} from "./unlock-rate-limit.ts";

export interface UnlockRouteDeps {
  plans: PlanRepo;
  /** The unlock counters, which are their own table - see below. */
  limits: RateLimitRepo;
  config: UnlockRateConfig & ShareCookieConfig;
  logger: Pick<Logger, "warn">;
}

export type UnlockRoute = (
  deps: UnlockRouteDeps,
  request: Request,
  planId: string,
) => Promise<Response>;

/**
 * Redeeming a share code, budget and all: the one request in this app that
 * takes no credential.
 *
 * Throttled per client address rather than per plan - the plan id travels in
 * the share link, so a per-plan bucket would let anyone holding that link lock
 * the real readers out. Its own counter table, because
 * `upload_rate_limit.key` is a foreign key onto `user.id` and there is no user
 * here.
 *
 * The budget is taken before the attempt and given back by one that turned out
 * to be a redemption - reserve first, refund on success, rather than charging
 * afterwards. A caller that walks away mid-request has therefore already been
 * counted, which is the safe direction. A correct code still costs nothing in
 * the end, because what is being rationed is guessing: the share link is opened
 * by everyone it was sent to, and charging those meant a link pasted into one
 * channel locked out the colleagues behind the same egress address. See
 * src/http/unlock-rate-limit.ts.
 *
 * A factory, called once per app, because of the one thing here that is not
 * per request: the missing-header warning below is said once per app instance.
 * The flag lives in this closure rather than in a module-level set keyed on the
 * config object, which made "once" depend on object identity, outlived the app
 * that built it, and left a test wanting the warning having to find a config no
 * earlier call had seen.
 */
export function createUnlockRoute(): UnlockRoute {
  let warnedMissingHeader = false;

  return async (deps, request, planId) => {
    const { config, limits, logger, plans } = deps;

    const reservation = await reserveUnlockAttempt(limits, config, request);
    if ("refused" in reservation) {
      /*
       * Said out loud, because the symptom is silent: every redemption on this
       * deployment answers 429 and no reader can tell why. Once per app, and
       * not per request - this route takes no credential, so repeating it would
       * let a stranger turn a flood of refused unlocks into a flood of log
       * lines. The refusal itself is still every time.
       */
      if (reservation.reason === "no-client-address" && !warnedMissingHeader) {
        warnedMissingHeader = true;
        logger.warn(
          { header: config.clientIpHeader },
          "no trusted client address header, so every unlock is refused",
        );
      }
      return reservation.refused;
    }

    /*
     * A redemption was never the thing being rationed, so a count that did not
     * buy a guess goes back. Both endings qualify: the `204`, and a throw -
     * the budget rations guessing, and a route that fell over told nobody
     * whether the code was right.
     *
     * Every other ending keeps its count, and not only the wrong-code `401`.
     * A `404` is an unknown plan id, which is the same enumeration by another
     * name; a `400` or `413` is a caller this endpoint cannot answer, and a
     * caller who can spend the budget on malformed bodies for free can hold
     * the window open while spending it elsewhere. Refunding narrowly is the
     * safe direction: the budget errs one lower rather than one higher.
     *
     * Swallowed on failure, and only on the refund: the reader has their
     * cookie, or their 500, and losing a refund leaves the budget one lower
     * than it should be - which errs towards refusing rather than towards
     * letting a guesser through.
     */
    const refund = async () => {
      try {
        await refundUnlockAttempt(limits, reservation);
      } catch (cause) {
        // The bucket and window, so a budget that never recovers can be found
        // rather than only known about. The bucket is already a keyed digest
        // of the address, not the address - see `unlockBucketKey`.
        logger.warn(
          {
            err: cause,
            bucket: reservation.bucket,
            windowStart: reservation.windowStart,
          },
          "unlock reservation was not refunded",
        );
      }
    };

    let response: Response;
    try {
      response = await unlockPlan(plans, config, request, planId);
    } catch (cause) {
      await refund();
      throw cause;
    }
    if (response.ok) await refund();
    return response;
  };
}
