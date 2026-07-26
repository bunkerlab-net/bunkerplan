import { bigint, integer, pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./auth.pg.ts";

/**
 * Upload rate-limit counters, one row per user, fixed window.
 *
 * Deliberately NOT the `rate_limit` table Better Auth generates. That one is
 * pruned in the background against Better Auth's own longest window, so a
 * `UPLOAD_RATE_WINDOW_SEC` longer than 60s would have its counters silently
 * deleted mid-window and the limit would reset early.
 *
 * `windowStart` is epoch milliseconds rather than a `timestamp` column so the
 * conditional upsert in src/db/rate-limits.pg.ts can compare it to a plain
 * bound number inside SQL.
 */
export const uploadRateLimit = pgTable("upload_rate_limit", {
  /**
   * The user id. Nothing prunes this table, so without the cascade a deleted
   * account would leave its counter behind for good.
   */
  key: text("key")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  count: integer("count").notNull(),
  windowStart: bigint("window_start", { mode: "number" }).notNull(),
});
