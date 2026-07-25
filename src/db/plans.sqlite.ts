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

export function createSqlitePlanRepo(db: SqliteDb): PlanRepo {
  return {
    async insert(row) {
      const inserted = await db
        .insert(plan)
        .values({ id: row.id, userId: row.userId, size: row.size })
        .onConflictDoNothing()
        .returning({ id: plan.id });
      return inserted.length > 0;
    },

    async listByUser(userId) {
      return await db
        .select({ id: plan.id, size: plan.size, createdAt: plan.createdAt })
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

    async deleteOwned(id, userId) {
      const deleted = await db
        .delete(plan)
        .where(and(eq(plan.id, id), eq(plan.userId, userId)))
        .returning({ id: plan.id });
      return deleted.length > 0;
    },
  };
}
