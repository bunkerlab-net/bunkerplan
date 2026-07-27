import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { PlanVisibility } from "../../services/types.ts";
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
    /** SHA-256 hex of the share code. Never leaves the repo layer. */
    shareCodeHash: text("share_code_hash"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("plan_userId_idx").on(table.userId)],
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
    index("plan_grant_userId_idx").on(table.userId),
  ],
);
