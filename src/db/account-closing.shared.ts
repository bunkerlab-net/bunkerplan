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
       *
       * `started_at` is written and nothing here reads it. That is deliberate:
       * it is for the operator, not for this module. A mark can outlive its
       * attempt in one case - Better Auth's own row delete failing after the
       * sweep succeeded, which it offers no hook for - and the age is what
       * distinguishes that leftover from a deletion running right now. The
       * query is in docs/self-hosting.md.
       *
       * No threshold and no alerting here. A repository method is the wrong
       * place to decide how long is too long: a sweep is bounded by the
       * subrequest budget on Workers and unbounded off it, so the only honest
       * threshold is deployment-specific. Nothing in this project collects
       * metrics, and inventing a channel for one counter would be a second
       * observability convention beside the logger.
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
