import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { Config } from "../config.ts";
import type { PgAuthHandle } from "../db/pg-shared.ts";
import type { SqliteAuthHandle } from "../db/sqlite-shared.ts";
import { toSecondaryStorage } from "../kv/secondary-storage.ts";
import { PLAN_PAGE_SIZE } from "../limits.ts";
import type { Logger } from "../log.ts";
import type { Db, KvStore, PlanStorage } from "../services/types.ts";
import { buildAuthOptions } from "./options.ts";

/**
 * Pages the sweep below will make before it gives up.
 *
 * `listByUser` is re-queried until it comes back empty, so the loop's exit
 * depends on the deletes actually removing rows. A `deleteOwned` that keeps
 * refusing - a row whose owner no longer matches, a repo bug - would hand back
 * the same page forever, inside a request. This is the bound that turns that
 * into a loud failure instead of a hung Worker, set far above any real
 * account: 500 pages of `PLAN_PAGE_SIZE`.
 */
const MAX_SWEEP_PAGES = 500;

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
 * concurrent subrequests and trip the Workers subrequest limit, and in pages
 * so the number of plans an account holds is not capped by whatever one query
 * returns.
 *
 * Exported to be callable on its own: this is the irreversible half of account
 * deletion, and reaching it through `betterAuth` would mean standing up an
 * auth instance to test paging and refusals.
 *
 * Throws rather than returning a partial result. Better Auth aborts the
 * deletion when this hook throws, which is the right end for an account whose
 * objects could not all be removed - the alternative deletes the rows naming
 * them.
 */
export async function sweepAccountObjects(input: {
  db: Db;
  storage: PlanStorage;
  logger: Logger;
  userId: string;
}): Promise<void> {
  const { db, storage, logger, userId } = input;
  await db.accountClosing.open(userId);

  let removed = 0;
  let refused = 0;
  for (let page = 0; ; page += 1) {
    if (page === MAX_SWEEP_PAGES) {
      throw new Error(
        `account ${userId} still lists plans after ${MAX_SWEEP_PAGES} pages ` +
          `of ${PLAN_PAGE_SIZE}: the sweep is not making progress, so the ` +
          "account has not been deleted",
      );
    }
    const rows = await db.plans.listByUser(userId, PLAN_PAGE_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) {
      await storage.delete(row.id);
      // The boolean is the only evidence a row went. Counting the attempt
      // instead would report a refusal as a removal, and a refusal is exactly
      // the thing that makes the loop above unable to finish.
      if (await db.plans.deleteOwned(row.id, userId)) removed += 1;
      else refused += 1;
    }
  }

  if (refused > 0) {
    logger.warn(
      { userId, planCount: removed, refusedCount: refused },
      "some plans were not deleted before account deletion",
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
}) {
  const { config, db, kv, storage, logger } = input;
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
        sweepAccountObjects({ db, storage, logger, userId }),
    }),
  );
}

/** The plugin-aware auth type. `Auth` from better-auth loses plugin endpoints. */
export type AppAuth = ReturnType<typeof createAuth>;
