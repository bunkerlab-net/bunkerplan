import { sql } from "drizzle-orm";
import type { AccountClosingRepo } from "../services/types.ts";
import type { Dialect } from "./dialect.ts";

export function createAccountClosingRepo(dialect: Dialect): AccountClosingRepo {
  const { accountClosing } = dialect.tables;
  return {
    async open(userId) {
      /*
       * A row of this attempt's own, so the mark it places is the mark it may
       * later lift. `randomUUID` rather than a counter: the id only has to be
       * unique, it is never shown, and both runtimes have it on `crypto`.
       *
       * No conflict clause and no read-then-write. Concurrent attempts insert
       * distinct rows and both succeed, which is the point - `isOpen` asks
       * whether any of them is present, so two overlapping deletions protect
       * the account together and neither can end the other's protection.
       */
      const attemptId = crypto.randomUUID();
      await dialect.run(sql`
        insert into ${accountClosing} (attempt_id, user_id, started_at)
        values (${attemptId}, ${userId}, ${Date.now()})
      `);
      return attemptId;
    },

    async close(attemptId) {
      // By attempt, never by account: a `where user_id = ...` here would let
      // one failed sweep clear a concurrent one's row as well as its own.
      await dialect.run(sql`
        delete from ${accountClosing} where attempt_id = ${attemptId}
      `);
    },

    async isOpen(userId) {
      const rows = await dialect.rows<{ attemptId: string }>(sql`
        select attempt_id as "attemptId" from ${accountClosing}
        where user_id = ${userId}
        limit 1
      `);
      return rows.length > 0;
    },
  };
}
