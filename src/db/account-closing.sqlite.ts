import { eq } from "drizzle-orm";
import type { AccountClosingRepo } from "../services/types.ts";
import { accountClosing } from "./schema/account-closing.sqlite.ts";
import type { SqliteDb } from "./sqlite-shared.ts";

export function createSqliteAccountClosingRepo(
  db: SqliteDb,
): AccountClosingRepo {
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
