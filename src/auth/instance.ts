import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { Config } from "../config.ts";
import type { PgAuthHandle } from "../db/pg-shared.ts";
import type { SqliteAuthHandle } from "../db/sqlite-shared.ts";
import { toSecondaryStorage } from "../kv/secondary-storage.ts";
import { PLAN_PAGE_SIZE } from "../limits.ts";
import type { Logger } from "../log.ts";
import type {
  AccountClosingRepo,
  Db,
  KvStore,
  PlanRepo,
  PlanStorage,
} from "../services/types.ts";
import { buildAuthOptions } from "./options.ts";

/**
 * The end of a sweep that cannot finish: `deleteOwned` refuses rows
 * `listByUser` keeps returning, and neither another pass nor another request
 * will change that answer.
 */
function stalled(userId: string, listed: number): Error {
  return new Error(
    `account ${userId} still lists ${listed} plan(s) that deleteOwned ` +
      "refuses to remove: the sweep is not making progress, so the account " +
      "has not been deleted",
  );
}

/**
 * Removes every object an account owns, ahead of the row cascade that account
 * deletion performs.
 *
 * Objects live outside the database, so no foreign key can clean them up. The
 * marker goes first and is what makes the rest safe: without it a sweep can
 * finish, an upload can then claim a row and write its object, and the cascade
 * that follows removes the row - leaving an object served at `/p/{id}` that
 * nothing owns and nothing can delete. With it, uploads for this account are
 * refused, and one already in flight withdraws its own object.
 *
 * Deleted sequentially so a user with many plans cannot open hundreds of
 * concurrent subrequests at once, and in pages so the number of plans an
 * account holds is not capped by whatever one query returns.
 *
 * Three endings, and the listing at the top of each pass is what tells them
 * apart. Nothing left: done. A row `deleteOwned` already refused, still
 * listed: stalled, because the next pass and the next request would both walk
 * into the same refusal - it throws, and no retry is suggested. Rows left but
 * the budget spent: throws asking to be retried, which works, because every
 * object and row already removed stays removed and the marker is idempotent.
 *
 * A refusal that stops being listed never reaches any of that. It is the
 * benign case - the owner deleted that plan while the sweep ran - and is
 * logged: the object is gone and no row is left naming it.
 *
 * `maxAttempts` is how many plans one call will try. A platform budget rather
 * than a policy: on Workers an invocation may make 1000 subrequests and each
 * plan here spends two, so a large enough account is one workerd would stop in
 * the middle of. Attempts, not removals - a refusal spends the same two calls
 * a removal does. Omitted off Workers, where nothing counts calls.
 *
 * The loop terminates because uploads are shut out by the marker, so rows only
 * ever leave: every pass removes at least one, records a refusal that stops
 * the next pass, or throws.
 *
 * Better Auth aborts the deletion when this hook throws, which is the right
 * end for an account whose objects could not all be removed - the alternative
 * deletes the rows naming them.
 *
 * Exported to be callable on its own: this is the irreversible half of account
 * deletion, and reaching it through `betterAuth` would mean standing up an
 * auth instance to test paging, refusals, and the budget.
 */
export async function sweepAccountObjects(input: {
  plans: PlanRepo;
  accountClosing: AccountClosingRepo;
  storage: PlanStorage;
  logger: Pick<Logger, "warn" | "info">;
  userId: string;
  maxAttempts?: number;
}): Promise<void> {
  const { plans, accountClosing, storage, logger, userId } = input;
  await accountClosing.open(userId);

  let removed = 0;
  let allowance = input.maxAttempts ?? Number.POSITIVE_INFINITY;
  // Rows `deleteOwned` refused. Kept because the next listing is what makes
  // them mean something: still there, and the sweep cannot finish; gone, and
  // another writer removed the plan while this ran.
  const refused = new Set<string>();
  for (;;) {
    const rows = await plans.listByUser(userId, PLAN_PAGE_SIZE);
    if (rows.length === 0) break;
    /*
     * Any refused row still listed, not only a page made entirely of them.
     * The two differ when a page mixes refusals with fresh rows, and stopping
     * there is the deliberate choice: `listByUser` orders the same way every
     * call, so a refused row keeps its place at the front and every later
     * attempt walks into it again. The sweep cannot finish while it is there,
     * whatever else the page holds.
     *
     * Carrying on would delete the fresh rows' objects first and then fail
     * anyway - the same ending, reached after destroying more. Better Auth
     * aborts on the throw either way, so those rows survive with their objects
     * gone, listing plans that 404. Stopping at the first one keeps that
     * wreckage to the row that caused it.
     */
    const stuck = rows.filter((row) => refused.has(row.id));
    if (stuck.length > 0) throw stalled(userId, stuck.length);
    if (allowance === 0) {
      throw new Error(
        `account ${userId} holds more plans than one invocation may sweep: ` +
          `${removed} removed, at least ${rows.length} left rather than run ` +
          "past the platform's subrequest budget. Retry the deletion to " +
          "continue - nothing already removed comes back",
      );
    }
    for (const row of rows) {
      // Out of budget: stop here and let the listing above classify what is
      // left. Re-listing costs one call, and it is the difference between an
      // account worth retrying and one that will refuse forever.
      if (allowance === 0) break;
      allowance -= 1;
      // Object first, then the row - not the other way round. Reversed, a
      // `deleteOwned` that succeeded followed by a `storage.delete` that threw
      // would leave an object with no row naming it, which nothing can find
      // again and nothing can remove. This way round the failure leaves a row
      // whose object is gone: the plan lists and 404s, and the next attempt
      // deletes it properly. One of those is recoverable and the other is not.
      await storage.delete(row.id);
      // The boolean is the only evidence a row went. Counting the attempt
      // instead would report a refusal as a removal, and a refusal is exactly
      // the thing that makes the loop above unable to finish.
      if (await plans.deleteOwned(row.id, userId)) removed += 1;
      else refused.add(row.id);
    }
  }

  if (refused.size > 0) {
    logger.warn(
      { userId, planCount: removed, refusedCount: refused.size },
      "some plans were removed by another writer during the account sweep",
    );
    return;
  }
  logger.info(
    { userId, planCount: removed },
    "deleted plan objects before account deletion",
  );
}

/**
 * `Db` plus the handle union: each driver constructs one member, so an
 * adapter tagged with the wrong provider cannot typecheck into `createAuth`.
 * `drizzleAdapter` itself indexes its argument loosely and would accept
 * anything - this type is where the pairing is enforced.
 */
export type AuthDb = Db & (SqliteAuthHandle | PgAuthHandle);

export function createAuth(input: {
  config: Config;
  db: AuthDb;
  kv: KvStore;
  storage: PlanStorage;
  logger: Logger;
  /**
   * Plans the account sweep will attempt per request. Passed by
   * src/runtime/cloudflare.ts and nothing else: it is the Workers subrequest
   * budget, and a process with no such budget must not inherit a ceiling on
   * how much of an account one deletion can finish.
   */
  maxSweepAttempts?: number;
}) {
  const { config, db, kv, storage, logger, maxSweepAttempts } = input;
  return betterAuth(
    buildAuthOptions({
      database: drizzleAdapter(db.adapter, {
        provider: db.provider,
      }),
      secondaryStorage: toSecondaryStorage(kv),
      baseURL: config.publicBaseUrl,
      secret: config.secret,
      rpId: config.rpId,
      rpName: config.rpName,
      clientIpHeader: config.clientIpHeader,
      logger,
      onBeforeDeleteUser: (userId) =>
        sweepAccountObjects({
          plans: db.plans,
          accountClosing: db.accountClosing,
          storage,
          logger,
          userId,
          maxAttempts: maxSweepAttempts,
        }),
    }),
  );
}

/** The plugin-aware auth type. `Auth` from better-auth loses plugin endpoints. */
export type AppAuth = ReturnType<typeof createAuth>;
