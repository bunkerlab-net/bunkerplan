import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { PlanVisibility } from "../../services/types.ts";
import { user } from "./auth.pg.ts";

export const plan = pgTable(
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("plan_userId_idx").on(table.userId)],
);

export const planGrant = pgTable(
  "plan_grant",
  {
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.userId] }),
    // Postgres does not index a foreign key automatically; without this,
    // deleting an account sequentially scans this table.
    index("plan_grant_userId_idx").on(table.userId),
  ],
);
