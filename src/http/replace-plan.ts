import type { PlanReplaced } from "../api/schemas.ts";
import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type {
  AccountClosingRepo,
  PlanRepo,
  PlanStorage,
  RateLimitRepo,
} from "../services/types.ts";
import { sweepOrphanedObject } from "./orphan-sweep.ts";
import { planUrl } from "./plan-url.ts";
import { problem } from "./problem.ts";
import { resolveUserId } from "./require-user.ts";
import { readUploadBody } from "./upload-body.ts";
import { checkUploadRate } from "./upload-rate-limit.ts";

/** Seven things, so they arrive named - as `CreatePlanDeps` does next door. */
export interface ReplacePlanDeps {
  auth: AppAuth;
  config: Pick<
    Config,
    "maxUploadBytes" | "publicBaseUrl" | "uploadRateMax" | "uploadRateWindowSec"
  >;
  plans: PlanRepo;
  uploadRateLimits: RateLimitRepo;
  storage: PlanStorage;
  accountClosing: AccountClosingRepo;
  logger: Logger;
}

/**
 * Replaces the document behind a plan the caller owns. The id, the public URL,
 * and the label are unchanged - only the bytes and the recorded size move.
 *
 * Object first, row second. A failed object write then changes nothing at all,
 * and `resize` matching on owner as well as id means a row that vanished under
 * a concurrent delete refuses the update, so the object just written is taken
 * back out again. The delete path sweeps once more after dropping the row,
 * which catches a write that landed inside its own window.
 *
 * The caller and their allowance are resolved here rather than in the router,
 * so a route registered later cannot forget either - the same reason
 * `createPlan` admits its own callers. Replacing draws on the upload allowance
 * because it writes an object of the same size; charging only the first upload
 * would leave the limit open to a loop that replaces one plan forever.
 *
 * No `DatabaseUnavailable` branch, unlike `createPlan`. That error is minted
 * in one place - `pgClaim` in src/db/pg-shared.ts - and `Dialect.claim` has
 * exactly one caller, the `insert` this handler never makes. `findOwner`,
 * `resize`, and the rate-limit counters all go through `dialect.rows` and
 * `dialect.run`, which translate nothing, so a database failure here arrives
 * as itself and is a fault. Catching a case that cannot occur would read as
 * though it could.
 */
export async function replacePlan(
  deps: ReplacePlanDeps,
  request: Request,
  id: string,
): Promise<Response> {
  const {
    accountClosing,
    auth,
    config,
    logger,
    plans,
    storage,
    uploadRateLimits,
  } = deps;

  const userId = await resolveUserId(auth, request);
  if (userId === null) return problem(401, "authentication required");

  const limited = await checkUploadRate(uploadRateLimits, config, userId);
  if (limited !== null) return limited;

  // 404 rather than 403 for someone else's plan: never confirm that an id
  // belonging to another account exists. Checked before the body is read, so
  // an upload for a plan the caller does not own is refused at the header.
  const notFound = () => problem(404, "not found");
  if ((await plans.findOwner(id)) !== userId) return notFound();

  const body = await readUploadBody(request, config.maxUploadBytes);
  if (body instanceof Response) return body;

  try {
    await storage.put(id, body);
  } catch (error) {
    // The row stays. A failed `put` leaves the previous object in place, so
    // the plan is still whole and still the caller's - unlike an upload, where
    // the row was claimed for an object that never landed.
    logger.error({ err: error, planId: id }, "plan replacement failed");
    return problem(502, "storage unavailable");
  }

  /*
   * Read after the write, and this is the interleaving it exists for: the
   * account sweep removes an object before the row naming it, so a
   * replacement landing between those two puts the object back, passes
   * `resize` against a row that is still there, and then loses that row to
   * the sweep. What is left is an object served at `/p/{id}` that nothing
   * owns and nothing can delete.
   *
   * `resize` cannot see it - the row is present when it runs - and reading
   * the marker before the write would say nothing about a deletion that
   * started since. Read here, a `false` orders this `put` ahead of the
   * marker, and therefore ahead of the sweep's own object delete, so the
   * sweep takes this object with the row.
   *
   * The deletion that already finished is the other half, and `resize` does
   * catch that one: `account_closing` cascades with the user, so the marker
   * is gone by then and the row is too. Same pair, same reasons, as
   * `storeAndConfirm` - which is not reused here only because its compensation
   * for a failed write is to drop the row.
   *
   * What this costs, now that a failed sweep lifts its own mark: the sweep
   * this deferred to may then fail, leaving the account alive and this plan's
   * row with it - pointing at an object this handler just withdrew. The owner
   * sees a plan that 404s.
   *
   * That is the recoverable direction, and it is chosen rather than tolerated.
   * The alternative is to keep the bytes and let the sweep collect them, which
   * loses the case this check exists for: a sweep that already passed this row
   * has deleted the object and the row, so bytes left behind are owned by
   * nothing, served at `/p/{id}`, and removable by no one. A row without an
   * object is a plan its owner can delete and a later sweep will clear - the
   * same trade the sweep itself makes when `storage.delete` succeeds and
   * `deleteOwned` then fails.
   */
  if (await accountClosing.isOpen(userId)) {
    await sweepOrphanedObject(storage, logger, id);
    return notFound();
  }

  if (!(await plans.resize(id, userId, body.byteLength))) {
    // The row went away between the two checks, so the object above now has no
    // owner. Nothing else can be holding it: ids are never reissued.
    await sweepOrphanedObject(storage, logger, id);
    return notFound();
  }

  return Response.json({
    id,
    url: planUrl(config.publicBaseUrl, id),
  } satisfies PlanReplaced);
}
