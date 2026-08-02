import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth.sqlite.ts";

/**
 * One row per attempt at deleting an account, not one per account.
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
 * "stop admitting plans for this account". Uploads refuse while any row for the
 * account is present, and an upload already in flight re-reads it after writing
 * its object and withdraws if one appeared meanwhile.
 *
 * Keyed by the attempt rather than the account because a mark that a failed
 * sweep must lift has to be attributable to the sweep that placed it. Two
 * deletions of one account each insert their own row; the first to fail
 * removes only its own and leaves the other still protected. One row keyed by
 * `user_id` could not express that - the second `open` would be a no-op, and
 * the first failure would strip the protection out from under a sweep still
 * running.
 *
 * Every row cascades with the user, so a completed deletion collects them all,
 * including any left behind by an earlier attempt that failed after its sweep.
 */
export const accountClosing = sqliteTable(
  "account_closing",
  {
    attemptId: text("attempt_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    startedAt: integer("started_at").notNull(),
  },
  (table) => [index("account_closing_user_idx").on(table.userId)],
);
