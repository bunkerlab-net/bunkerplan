import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth.sqlite.ts";

/**
 * One row per account whose deletion has begun.
 *
 * Deleting an account has to remove objects the database knows nothing about,
 * so it lists the user's plans, deletes their objects, and lets the foreign key
 * take the rows. Without a marker that sequence races an upload in a way no
 * amount of re-checking closes: the sweep finishes, an upload then claims a row
 * and writes its object, and the cascade that follows removes the row it just
 * confirmed - leaving an object at `/p/{id}` that no row owns and no code path
 * can reach.
 *
 * The marker is written before the sweep starts, so it is the thing that says
 * "stop admitting plans for this account". Uploads refuse when it is present,
 * and an upload already in flight re-reads it after writing its object and
 * withdraws if it appeared meanwhile.
 *
 * Cascades with the user, so a completed deletion cleans it up and a failed one
 * leaves it - which is the safe direction: the account is unusable until an
 * operator looks.
 */
export const accountClosing = sqliteTable("account_closing", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  startedAt: integer("started_at").notNull(),
});
