import { and, count, desc, eq, type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { handleEmail } from "../ids.ts";
import type {
  PlanInsert,
  PlanRepo,
  PlanVisibility,
} from "../services/types.ts";
import type { PgSchema } from "./pg-shared.ts";
import { user } from "./schema/auth.pg.ts";
import { plan, planGrant } from "./schema/plan.pg.ts";

type PgDb = NodePgDatabase<PgSchema>;

/** False means no row matched: unknown id, or one owned by somebody else. */
async function updateOwned(
  db: PgDb,
  id: string,
  userId: string,
  /** Each column takes its own type, or SQL computing it from the old row. */
  fields: Partial<{
    [K in keyof typeof plan.$inferInsert]: (typeof plan.$inferInsert)[K] | SQL;
  }>,
  /** Extra condition the row must also satisfy, folded into the same write. */
  guard?: SQL,
): Promise<boolean> {
  const owned = and(eq(plan.id, id), eq(plan.userId, userId));
  const updated = await db
    .update(plan)
    .set(fields)
    .where(guard === undefined ? owned : and(owned, guard))
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
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${row.userId})::bigint)`,
    );

    const claimed = await tx.execute<{ id: string }>(sql`
      insert into ${plan} (id, user_id, label, size, visibility, share_code_hash)
      select ${row.id}, ${row.userId}, ${row.label}, ${row.size},
             ${row.visibility}, ${row.shareCodeHash}
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

/** Reading and setting who may see a plan. */
function accessMethods(
  db: PgDb,
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

    /**
     * See the sqlite twin: neither visibility leaves a code on a public plan,
     * and a row that was already private keeps its own.
     */
    setVisibility: (id, userId, visibility) =>
      updateOwned(
        db,
        id,
        userId,
        visibility === "public"
          ? { visibility, shareCodeHash: null }
          : {
              visibility,
              shareCodeHash: sql`case when ${plan.visibility} = 'public' then null else ${plan.shareCodeHash} end`,
            },
      ),

    /** Private-only, like the sqlite twin, and for the same reason. */
    setShareCodeHash: (id, userId, hash) =>
      updateOwned(
        db,
        id,
        userId,
        { shareCodeHash: hash },
        hash === null ? undefined : eq(plan.visibility, "private"),
      ),
  };
}

export function createPgPlanRepo(db: PgDb): PlanRepo {
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
 * The one account a caller's token names, as a scalar subquery.
 *
 * A token is a handle or an account id, and the two live in different
 * columns, so a plain `email = ... or id = ...` could match two different
 * people at once - an operator who renamed an account to something that
 * happens to equal another account's id would have granted both. `coalesce`
 * of two unique-index lookups yields exactly one id or null: the id wins on
 * an exact match, and the handle is only consulted when no account carries
 * that id.
 */
function accountId(account: string, email: string): SQL {
  return sql`coalesce(
    (select id from ${user} where id = ${account}),
    (select id from ${user} where email = ${email})
  )`;
}

/**
 * The `plan_grant` half, kept apart because it is the only part of this repo
 * that joins `user` - and because the two dialect files stay legible only
 * while each function does one thing.
 */
function grantMethods(
  db: PgDb,
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

    async grantByHandle(planId, ownerId, account) {
      const email = handleEmail(account);
      // One statement: the insert-select carries both the ownership check and
      // the account lookup, so nothing is read on the path that succeeds.
      // `user` is a reserved word here, so it is only ever referenced through
      // the drizzle object, which quotes it.
      const granted = await db.execute<{ user_id: string }>(sql`
        insert into ${planGrant} (plan_id, user_id)
        select p.id, u.id from ${plan} p, ${user} u
        where p.id = ${planId} and p.user_id = ${ownerId}
          and u.id = ${accountId(account, email)}
        on conflict do nothing
        returning user_id
      `);
      if (granted.rows.length > 0) return "granted";

      // Only on the empty path, the same "read after failure" idiom as
      // `insert`. Both present means the row already existed, which makes a
      // repeated grant idempotent rather than an error.
      const probe = await db.execute<{
        owned: number | null;
        uid: string | null;
      }>(sql`
        select
          (select 1 from ${plan}
            where id = ${planId} and user_id = ${ownerId}) as owned,
          ${accountId(account, email)} as uid
      `);
      // Ownership first: a plan the caller does not own answers "no-plan"
      // whatever the account was, so nothing about a stranger's plan - not
      // even which of the two things they got wrong - comes back to them.
      if (!probe.rows[0]?.owned) return "no-plan";
      if (!probe.rows[0].uid) return "no-user";
      return "granted";
    },

    async revokeByHandle(planId, ownerId, account) {
      const email = handleEmail(account);
      const revoked = await db.execute<{ user_id: string }>(sql`
        delete from ${planGrant}
        where plan_id = ${planId}
          and user_id = ${accountId(account, email)}
          and exists (
            select 1 from ${plan} where id = ${planId} and user_id = ${ownerId}
          )
        returning user_id
      `);
      return revoked.rows.length > 0;
    },
  };
}
