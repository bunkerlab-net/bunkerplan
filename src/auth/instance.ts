import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { Config } from "../config.ts";
import { toSecondaryStorage } from "../kv/secondary-storage.ts";
import type { Logger } from "../log.ts";
import {
  type Db,
  type KvStore,
  PLAN_PAGE_SIZE,
  type PlanStorage,
} from "../services/types.ts";
import { buildAuthOptions } from "./options.ts";

export function createAuth(input: {
  config: Config;
  db: Db;
  kv: KvStore;
  storage: PlanStorage;
  logger: Logger;
}) {
  const { config, db, kv, storage, logger } = input;
  return betterAuth(
    buildAuthOptions({
      // The single cast in the codebase: the D1, bun-sqlite, and node-postgres
      // drizzle instances are structurally different types that drizzleAdapter
      // accepts at runtime but cannot be unified statically.
      database: drizzleAdapter(db.adapter as never, {
        provider: db.provider,
      }),
      secondaryStorage: toSecondaryStorage(kv),
      baseURL: config.publicBaseUrl,
      secret: config.secret,
      rpId: config.rpId,
      rpName: config.rpName,
      clientIpHeader: config.clientIpHeader,
      logger,
      // Objects live outside the database, so no foreign key can clean them
      // up. Deleted sequentially so a user with many plans cannot open
      // hundreds of concurrent subrequests and trip the Workers subrequest
      // limit, and in pages so the number of plans an account holds is not
      // capped by whatever one query returns - the foreign key removes every
      // row regardless, so anything this loop failed to reach would be an
      // object nothing could ever delete. Each page drops its rows too, which
      // is what makes the loop terminate.
      onBeforeDeleteUser: async (userId) => {
        let removed = 0;
        for (;;) {
          const page = await db.plans.listByUser(userId, PLAN_PAGE_SIZE);
          if (page.length === 0) break;
          for (const row of page) {
            await storage.delete(row.id);
            await db.plans.deleteOwned(row.id, userId);
            removed += 1;
          }
        }
        logger.info(
          { userId, planCount: removed },
          "deleted plan objects before account deletion",
        );
      },
    }),
  );
}

/** The plugin-aware auth type. `Auth` from better-auth loses plugin endpoints. */
export type AppAuth = ReturnType<typeof createAuth>;
