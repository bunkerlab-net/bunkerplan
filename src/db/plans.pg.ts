import { and, count, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PlanInsert, PlanRepo } from "../services/types.ts";
import type { PgSchema } from "./pg-shared.ts";
import { plan } from "./schema/plan.pg.ts";

type PgDb = NodePgDatabase<PgSchema>;

/** False means no row matched: unknown id, or one owned by somebody else. */
async function updateOwned(
  db: PgDb,
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

/**
 * Claims an id for an account that is still under its ceiling.
 *
 * Postgres reads the count from its snapshot, so unlike SQLite - which
 * serialises writers for us - two concurrent claims at `maxPlans - 1` would
 * both see room and both write. The advisory lock makes count-and-claim one
 * critical section per account, and it is released with the transaction
 * whichever way it ends.
 */
async function claimRow(
  db: PgDb,
  row: { id: string; userId: string; label: string | null; size: number },
  maxPlans: number,
): Promise<PlanInsert> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${row.userId})::bigint)`,
    );

    const claimed = await tx.execute<{ id: string }>(sql`
      insert into ${plan} (id, user_id, label, size)
      select ${row.id}, ${row.userId}, ${row.label}, ${row.size}
      where (
        select count(*) from ${plan} where user_id = ${row.userId}
      ) < ${maxPlans}
      on conflict do nothing
      returning id
    `);
    if (claimed.rows.length > 0) return "created";

    // Nothing was written, and the two causes need opposite handling. The
    // count is only read here, on the path that has already failed.
    const rows = await tx
      .select({ total: count() })
      .from(plan)
      .where(eq(plan.userId, row.userId));
    return (rows[0]?.total ?? 0) >= maxPlans ? "quota" : "duplicate";
  });
}

export function createPgPlanRepo(db: PgDb): PlanRepo {
  return {
    insert: (row, maxPlans) => claimRow(db, row, maxPlans),

    async listByUser(userId, limit) {
      return await db
        .select({
          id: plan.id,
          label: plan.label,
          size: plan.size,
          createdAt: plan.createdAt,
        })
        .from(plan)
        .where(eq(plan.userId, userId))
        .orderBy(desc(plan.createdAt))
        .limit(limit);
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
