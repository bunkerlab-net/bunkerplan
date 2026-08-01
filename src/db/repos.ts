import type { Logger } from "../log.ts";
import type { Db } from "../services/types.ts";
import { createAccountClosingRepo } from "./account-closing.shared.ts";
import type { Dialect } from "./dialect.ts";
import { createPlanRepo } from "./plans.shared.ts";
import {
  createRateLimitRepo,
  createUnlockRateLimitRepo,
} from "./rate-limits.shared.ts";

/** Everything in `Db` that is decided by the dialect rather than the driver. */
export type DialectRepos = Pick<
  Db,
  "plans" | "uploadRateLimits" | "unlockRateLimits" | "accountClosing"
>;

/**
 * The repositories, wired once for all three drivers.
 *
 * D1, bun:sqlite, and node-postgres differ in how they open a handle and how
 * they answer a probe; past that they build the identical four repositories
 * over their own `Dialect`. Written out in each driver, that list drifted -
 * the upload counter's table was defaulted in one place and named in another -
 * so it is written here instead and the drivers keep only what is genuinely
 * theirs.
 *
 * `logger` is the unlock bucket's: its prune is housekeeping that must not
 * fail a redemption, so a failure is logged rather than raised.
 */
export function createDialectRepos(
  dialect: Dialect,
  logger: Pick<Logger, "warn">,
): DialectRepos {
  return {
    plans: createPlanRepo(dialect),
    uploadRateLimits: createRateLimitRepo(
      dialect,
      dialect.tables.uploadRateLimit,
    ),
    unlockRateLimits: createUnlockRateLimitRepo(dialect, logger),
    accountClosing: createAccountClosingRepo(dialect),
  };
}
