import { and, desc, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { PlanRepo } from "../services/types.ts";
import { plan } from "./schema/plan.sqlite.ts";
import type { SqliteSchema } from "./sqlite-shared.ts";

/**
 * Both the D1 and bun:sqlite drizzle instances extend BaseSQLiteDatabase; the
 * only difference that matters here is sync vs async result kind, and every
 * query builder below is awaited, which works for both.
 */
type SqliteDb = BaseSQLiteDatabase<"sync" | "async", unknown, SqliteSchema>;

/** False means no row matched: unknown id, or one owned by somebody else. */
async function updateOwned(
  db: SqliteDb,
  id: string,
  userId: string,
  fields: Partial<typeof plan.$inferInsert>,
): Promise<boolean> {
  const updated = await db
    .update(plan)
    .set(fields)
    .where(and(eq(plan.id, id), eq(plan.userId, userId)))
    .returning({ id: plan.id });
  return updated.length > 0;
}

export function createSqlitePlanRepo(db: SqliteDb): PlanRepo {
  return {
    async insert(row) {
      const inserted = await db
        .insert(plan)
        .values({
          id: row.id,
          userId: row.userId,
          label: row.label,
          size: row.size,
        })
        .onConflictDoNothing()
        .returning({ id: plan.id });
      return inserted.length > 0;
    },

    async listByUser(userId) {
      return await db
        .select({
          id: plan.id,
          label: plan.label,
          size: plan.size,
          createdAt: plan.createdAt,
        })
        .from(plan)
        .where(eq(plan.userId, userId))
        .orderBy(desc(plan.createdAt));
    },

    async findOwner(id) {
      const rows = await db
        .select({ userId: plan.userId })
        .from(plan)
        .where(eq(plan.id, id))
        .limit(1);
      return rows[0]?.userId ?? null;
    },

    relabel: (id, userId, label) => updateOwned(db, id, userId, { label }),

    resize: (id, userId, size) => updateOwned(db, id, userId, { size }),

    async deleteOwned(id, userId) {
      const deleted = await db
        .delete(plan)
        .where(and(eq(plan.id, id), eq(plan.userId, userId)))
        .returning({ id: plan.id });
      return deleted.length > 0;
    },
  };
}
