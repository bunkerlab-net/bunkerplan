import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { Config } from "../config.ts";
import { toSecondaryStorage } from "../kv/secondary-storage.ts";
import type { Logger } from "../log.ts";
import type { Db, KvStore, PlanStorage } from "../services/types.ts";
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
      // The single cast in the codebase: the D1, bun-sqlite and node-postgres
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
      // Objects live outside the database, so no foreign key can clean them up.
      // Deleted sequentially so a user with many plans cannot open hundreds of
      // concurrent subrequests and trip the Workers subrequest limit. A throw
      // aborts the account deletion, which beats stranding public objects.
      onBeforeDeleteUser: async (userId) => {
        const plans = await db.plans.listByUser(userId);
        logger.info(
          { userId, planCount: plans.length },
          "deleting plan objects before account deletion",
        );
        for (const row of plans) await storage.delete(row.id);
      },
    }),
  );
}

/** The plugin-aware auth type. `Auth` from better-auth loses plugin endpoints. */
export type AppAuth = ReturnType<typeof createAuth>;
