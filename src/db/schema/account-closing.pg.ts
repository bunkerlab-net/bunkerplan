import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./auth.pg.ts";

/** See the note on the SQLite table; this is the same marker for Postgres. */
export const accountClosing = pgTable(
  "account_closing",
  {
    attemptId: text("attempt_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
  },
  (table) => [index("account_closing_user_idx").on(table.userId)],
);
