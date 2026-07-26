import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AccountClosingRepo } from "../services/types.ts";
import type { PgSchema } from "./pg-shared.ts";
import { accountClosing } from "./schema/account-closing.pg.ts";

type PgDb = NodePgDatabase<PgSchema>;

export function createPgAccountClosingRepo(db: PgDb): AccountClosingRepo {
  return {
    async open(userId) {
      await db
        .insert(accountClosing)
        .values({ userId, startedAt: Date.now() })
        // Idempotent: a deletion retried after a failure must not trip over
        // the marker its own previous attempt left behind.
        .onConflictDoNothing();
    },

    async isOpen(userId) {
      const rows = await db
        .select({ userId: accountClosing.userId })
        .from(accountClosing)
        .where(eq(accountClosing.userId, userId))
        .limit(1);
      return rows.length > 0;
    },
  };
}
