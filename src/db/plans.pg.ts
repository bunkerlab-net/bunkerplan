import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PlanRepo } from "../services/types.ts";
import type { PgSchema } from "./pg-shared.ts";
import { plan } from "./schema/plan.pg.ts";

export function createPgPlanRepo(db: NodePgDatabase<PgSchema>): PlanRepo {
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

    async relabel(id, userId, label) {
      const updated = await db
        .update(plan)
        .set({ label })
        .where(and(eq(plan.id, id), eq(plan.userId, userId)))
        .returning({ id: plan.id });
      return updated.length > 0;
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
