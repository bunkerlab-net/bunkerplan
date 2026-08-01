import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { PLAN_VISIBILITIES, type PlanVisibility } from "../../limits.ts";
import { user } from "./auth.sqlite.ts";

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
    // The column is named unqualified rather than through `table.visibility`
    // on purpose. SQLite has no `ADD CONSTRAINT`, so drizzle rebuilds the
    // table: it creates `__new_plan`, copies, drops `plan`, and renames. A
    // qualified reference is emitted as `"__new_plan"."visibility"` and is
    // re-parsed after the rename, when that table name no longer exists -
    // "error in table plan after rename: no such column".
    //
    // The two values come from the tuple in src/limits.ts rather than being
    // typed out again. `sql.raw`, because this text is emitted into a migration
    // where a bound parameter would have no meaning.
    check(
      "plan_visibility_check",
      sql.raw(
        `"visibility" in (${PLAN_VISIBILITIES.map((v) => `'${v}'`).join(", ")})`,
      ),
    ),
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
