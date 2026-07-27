import { and, count, desc, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { handleEmail } from "../ids.ts";
import type {
  PlanInsert,
  PlanRepo,
  PlanVisibility,
} from "../services/types.ts";
import { user } from "./schema/auth.sqlite.ts";
import { plan, planGrant } from "./schema/plan.sqlite.ts";
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

/**
 * Claims an id for an account that is still under its ceiling.
 *
 * One statement decides both questions. `select ... where` makes the quota
 * part of the claim rather than something read beforehand, which two
 * concurrent uploads would both pass at the boundary; `on conflict do nothing`
 * keeps the id collision behaviour. SQLite serialises writers, so this is
 * atomic for free - the Postgres twin needs an advisory lock for the same
 * guarantee.
 */
async function claimRow(
  db: SqliteDb,
  // Spelled out rather than `typeof plan.$inferInsert`, which makes the two
  // defaulted columns optional and would let a caller omit exactly the values
  // this statement binds. Identical to the Postgres twin on purpose.
  row: {
    id: string;
    userId: string;
    label: string | null;
    size: number;
    visibility: PlanVisibility;
    shareCodeHash: string | null;
  },
  maxPlans: number,
): Promise<PlanInsert> {
  const claimed = await db.all<{ id: string }>(sql`
    insert into ${plan} (id, user_id, label, size, visibility, share_code_hash)
    select ${row.id}, ${row.userId}, ${row.label}, ${row.size},
           ${row.visibility}, ${row.shareCodeHash}
    where (
      select count(*) from ${plan} where user_id = ${row.userId}
    ) < ${maxPlans}
    on conflict do nothing
    returning id
  `);
  if (claimed.length > 0) return "created";

  // Nothing was written, and the two causes need opposite handling. The count
  // is only read here, on the path that has already failed.
  const rows = await db
    .select({ total: count() })
    .from(plan)
    .where(eq(plan.userId, row.userId));
  return (rows[0]?.total ?? 0) >= maxPlans ? "quota" : "duplicate";
}

/** Reading and setting who may see a plan. */
function accessMethods(
  db: SqliteDb,
): Pick<
  PlanRepo,
  "findAccess" | "hasGrant" | "setVisibility" | "setShareCodeHash"
> {
  return {
    async findAccess(id) {
      const rows = await db
        .select({
          ownerId: plan.userId,
          visibility: plan.visibility,
          shareCodeHash: plan.shareCodeHash,
        })
        .from(plan)
        .where(eq(plan.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async hasGrant(planId, userId) {
      const rows = await db
        .select({ userId: planGrant.userId })
        .from(planGrant)
        .where(and(eq(planGrant.planId, planId), eq(planGrant.userId, userId)))
        .limit(1);
      return rows.length > 0;
    },

    setVisibility: (id, userId, visibility) =>
      updateOwned(db, id, userId, { visibility }),

    setShareCodeHash: (id, userId, hash) =>
      updateOwned(db, id, userId, { shareCodeHash: hash }),
  };
}

export function createSqlitePlanRepo(db: SqliteDb): PlanRepo {
  return {
    insert: (row, maxPlans) => claimRow(db, row, maxPlans),

    async listByUser(userId, limit) {
      const rows = await db
        .select({
          id: plan.id,
          label: plan.label,
          size: plan.size,
          createdAt: plan.createdAt,
          visibility: plan.visibility,
          shareCodeHash: plan.shareCodeHash,
        })
        .from(plan)
        .where(eq(plan.userId, userId))
        .orderBy(desc(plan.createdAt))
        .limit(limit);
      // The hash must not escape the repo: the dashboard only needs to know
      // whether a code exists.
      return rows.map(({ shareCodeHash, ...rest }) => ({
        ...rest,
        hasShareCode: shareCodeHash !== null,
      }));
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

    ...accessMethods(db),

    ...grantMethods(db),
  };
}

/**
 * The `plan_grant` half, kept apart because it is the only part of this repo
 * that joins `user` - and because the two dialect files stay legible only
 * while each function does one thing.
 */
function grantMethods(
  db: SqliteDb,
): Pick<PlanRepo, "listGrantHandles" | "grantByHandle" | "revokeByHandle"> {
  return {
    async listGrantHandles(planId, ownerId) {
      const owned = await db
        .select({ id: plan.id })
        .from(plan)
        .where(and(eq(plan.id, planId), eq(plan.userId, ownerId)))
        .limit(1);
      // Empty is a real answer; null is a refusal. The caller renders a
      // different response for each.
      if (owned.length === 0) return null;
      const rows = await db
        .select({ handle: user.name })
        .from(planGrant)
        .innerJoin(user, eq(user.id, planGrant.userId))
        .where(eq(planGrant.planId, planId));
      return rows.map((r) => r.handle);
    },

    async grantByHandle(planId, ownerId, handle) {
      const email = handleEmail(handle);
      // One statement: the insert-select carries both the ownership check and
      // the handle lookup, so nothing is read on the path that succeeds.
      const granted = await db.all<{ user_id: string }>(sql`
        insert into ${planGrant} (plan_id, user_id)
        select p.id, u.id from ${plan} p, ${user} u
        where p.id = ${planId} and p.user_id = ${ownerId} and u.email = ${email}
        on conflict do nothing
        returning user_id
      `);
      if (granted.length > 0) return "granted";

      // Only on the empty path, the same "read after failure" idiom as
      // `insert`. Both present means the row already existed, which makes a
      // repeated grant idempotent rather than an error.
      const probe = await db.all<{ owned: number | null; uid: string | null }>(
        sql`
          select
            (select 1 from ${plan}
              where id = ${planId} and user_id = ${ownerId}) as owned,
            (select id from ${user} where email = ${email}) as uid
        `,
      );
      if (!probe[0]?.uid) return "no-user";
      if (!probe[0].owned) return "no-plan";
      return "granted";
    },

    async revokeByHandle(planId, ownerId, handle) {
      const email = handleEmail(handle);
      const revoked = await db.all<{ user_id: string }>(sql`
        delete from ${planGrant}
        where plan_id = ${planId}
          and user_id = (select id from ${user} where email = ${email})
          and exists (
            select 1 from ${plan} where id = ${planId} and user_id = ${ownerId}
          )
        returning user_id
      `);
      return revoked.length > 0;
    },
  };
}
