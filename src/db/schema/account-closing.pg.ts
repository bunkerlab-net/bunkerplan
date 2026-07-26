import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./auth.pg.ts";

/** See the note on the SQLite table; this is the same marker for Postgres. */
export const accountClosing = pgTable("account_closing", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
});
