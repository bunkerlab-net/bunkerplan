import { sql } from "drizzle-orm";
import type { AccountClosingRepo } from "../services/types.ts";
import type { Dialect } from "./dialect.ts";

export function createAccountClosingRepo(dialect: Dialect): AccountClosingRepo {
  const { accountClosing } = dialect.tables;
  return {
    async open(userId) {
      // Idempotent: a deletion retried after a failure must not trip over the
      // marker its own previous attempt left behind.
      await dialect.run(sql`
        insert into ${accountClosing} (user_id, started_at)
        values (${userId}, ${Date.now()})
        on conflict do nothing
      `);
    },

    async isOpen(userId) {
      const rows = await dialect.rows<{ userId: string }>(sql`
        select user_id as "userId" from ${accountClosing}
        where user_id = ${userId}
        limit 1
      `);
      return rows.length > 0;
    },
  };
}
