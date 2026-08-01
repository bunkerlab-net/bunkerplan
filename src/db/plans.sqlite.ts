import { and, count, desc, eq, type SQL, sql } from "drizzle-orm";
import { handleEmail } from "../ids.ts";
import type {
  PlanInsert,
  PlanRepo,
  PlanVisibility,
} from "../services/types.ts";
import { user } from "./schema/auth.sqlite.ts";
import { plan, planGrant } from "./schema/plan.sqlite.ts";
import type { SqliteDb } from "./sqlite-shared.ts";

/** False means no row matched: unknown id, or one owned by somebody else. */
async function updateOwned(
  db: SqliteDb,
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
 * One statement decides both questions. `select ... where` makes the quota
 * part of the claim rather than something read beforehand, which two
 * concurrent uploads would both pass at the boundary; `on conflict do nothing`
 * keeps the id collision behaviour.
 *
 * The atomicity is statement-level: count-and-claim cannot be interleaved
 * because it is one statement, and SQLite serialises writers. It says nothing
 * about two calls to this function, which are two statements and not one
 * unit. The Postgres twin needs an advisory lock to get the same
 * statement-level guarantee, because it counts against a snapshot.
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

    /**
     * Visibility and the share code are independent: neither direction touches
     * the hash, and neither touches grants.
     *
     * Clearing on the way to public destroyed a credential over a change that
     * was not about the credential. The dashboard did warn, but the warning was
     * the whole problem - an owner opening a plan up for a week had to choose
     * between that and keeping a link already handed out. Now the code that
     * worked before the flip works after it.
     *
     * Nothing is armed in the meantime that was not already reachable:
     * `resolvePlanAccess` grants on `visibility` before it reads the hash, so a
     * public plan is served to anyone holding the URL either way. A retained
     * code gates nothing while public because there is nothing left to gate.
     *
     * Retiring a code is `POST /share-code` (replaces it) or `DELETE` (drops
     * it). Both say so precisely; a visibility change does not.
     */
    setVisibility: (id, userId, visibility) =>
      updateOwned(db, id, userId, { visibility }),

    /**
     * Minting requires the plan to be private - a policy now rather than an
     * invariant, since a flip keeps a code. A public plan is readable by anyone
     * holding the URL, so a *new* code would gate nothing, and the dashboard
     * disables the control while public for that reason. In the statement so a
     * concurrent flip cannot land a code on a plan the caller thought private.
     *
     * Clearing is allowed whatever the visibility, because destroying a code
     * must never depend on the plan's current state.
     */
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
          // See the note on the Postgres side: `exists` so a plan shared with
          // forty accounts still returns one row, mapped because SQLite
          // answers 0/1 where Postgres answers a boolean.
          hasGrants: sql<boolean>`exists (
            select 1 from ${planGrant} where ${planGrant.planId} = ${plan.id}
          )`.mapWith(Boolean),
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

    async grantByHandle(planId, ownerId, account) {
      const email = handleEmail(account);
      // One statement: the insert-select carries both the ownership check and
      // the account lookup, so nothing is read on the path that succeeds.
      const granted = await db.all<{ user_id: string }>(sql`
        insert into ${planGrant} (plan_id, user_id)
        select p.id, u.id from ${plan} p, ${user} u
        where p.id = ${planId} and p.user_id = ${ownerId}
          and u.id = ${accountId(account, email)}
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
            ${accountId(account, email)} as uid
        `,
      );
      // Ownership first: a plan the caller does not own answers "no-plan"
      // whatever the account was, so nothing about a stranger's plan - not
      // even which of the two things they got wrong - comes back to them.
      if (!probe[0]?.owned) return "no-plan";
      if (!probe[0].uid) return "no-user";
      return "granted";
    },

    async revokeByHandle(planId, ownerId, account) {
      const email = handleEmail(account);
      const revoked = await db.all<{ user_id: string }>(sql`
        delete from ${planGrant}
        where plan_id = ${planId}
          and user_id = ${accountId(account, email)}
          and exists (
            select 1 from ${plan} where id = ${planId} and user_id = ${ownerId}
          )
        returning user_id
      `);
      return revoked.length > 0;
    },
  };
}
