import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { PlanVisibility } from "../../limits.ts";
import { user } from "./auth.sqlite.ts";
import { PLAN_VISIBILITY_CHECK } from "./visibility-check.ts";

export const plan = sqliteTable(
  "plan",
  {
    /** The nanoid. Also the storage object key and the public URL path. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Owner-facing text. Never stored on the object, never public. */
    label: text("label"),
    size: integer("size").notNull(),
    visibility: text("visibility")
      .$type<PlanVisibility>()
      .notNull()
      .default("private"),
    /**
     * SHA-256 hex of the share code. The read gate compares against it, so it
     * does leave the repo - but it MUST NOT reach a response body or a log:
     * it is what would let a holder forge this plan's unlock cookie.
     */
    shareCodeHash: text("share_code_hash"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("plan_userId_idx").on(table.userId),
    // `$type` is a compile-time claim and the repo is not the only writer -
    // a migration or a console session can put anything in this column, and
    // the read gate treats every value that is not "public" as private.
    //
    // The expression itself lives in src/db/schema/visibility-check.ts, beside
    // the reasons it is shaped the way it is: derived from one tuple, spelled
    // identically for both dialects, and unqualified because the rebuild
    // SQLite performs would re-parse `"__new_plan"."visibility"` after the
    // rename. `sql.raw`, because this text is emitted into a migration where a
    // bound parameter would have no meaning.
    check("plan_visibility_check", sql.raw(PLAN_VISIBILITY_CHECK)),
  ],
);

export const planGrant = sqliteTable(
  "plan_grant",
  {
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.userId] }),
    // SQLite does not index a foreign key automatically either; without this,
    // deleting an account scans this table. Same reason as the Postgres twin.
    index("plan_grant_userId_idx").on(table.userId),
  ],
);
