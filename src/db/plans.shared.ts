import { type SQL, sql } from "drizzle-orm";
import { handleEmail } from "../ids.ts";
import type { PlanVisibility } from "../limits.ts";
import type { PlanInsert, PlanRepo } from "../services/types.ts";
import type { Dialect, DialectTables } from "./dialect.ts";

/**
 * The columns a write may set, and the column name each carries in SQL.
 *
 * Scalars only. Every update below sets a value the caller already holds, and
 * the one write that has to read the old rows - the claim's count - is its own
 * statement.
 */
const WRITABLE = {
  label: "label",
  size: "size",
  visibility: "visibility",
  shareCodeHash: "share_code_hash",
} as const;

type PlanWrite = Partial<{
  label: string | null;
  size: number;
  visibility: PlanVisibility;
  shareCodeHash: string | null;
}>;

/** False means no row matched: unknown id, or one owned by somebody else. */
async function updateOwned(
  dialect: Dialect,
  id: string,
  userId: string,
  fields: PlanWrite,
  /** Extra condition the row must also satisfy, folded into the same write. */
  guard?: SQL,
): Promise<boolean> {
  const assignments = sql.join(
    Object.entries(fields).map(
      ([column, value]) =>
        sql`${sql.identifier(WRITABLE[column as keyof PlanWrite])} = ${value}`,
    ),
    sql`, `,
  );
  const updated = await dialect.rows<{ id: string }>(sql`
    update ${dialect.tables.plan}
    set ${assignments}
    where id = ${id} and user_id = ${userId}
      ${guard === undefined ? sql.empty() : sql`and ${guard}`}
    returning id
  `);
  return updated.length > 0;
}

/**
 * Claims an id for an account that is still under its ceiling.
 *
 * One statement decides both questions. `select ... where` makes the quota part
 * of the claim rather than something read beforehand, which two concurrent
 * uploads would both pass at the boundary; `on conflict do nothing` keeps the
 * id collision behaviour.
 *
 * `dialect.claim` is what makes count-and-claim one critical section on an
 * engine that needs one told - see the note there for why Postgres takes an
 * advisory lock and SQLite takes nothing.
 */
async function claimRow(
  dialect: Dialect,
  // Spelled out rather than `typeof plan.$inferInsert`, which makes the two
  // defaulted columns optional and would let a caller omit exactly the values
  // this statement binds.
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
  const { plan } = dialect.tables;
  return await dialect.claim(row.userId, async (executor) => {
    const claimed = await executor.rows<{ id: string }>(sql`
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
    // is only read here, on the path that has already failed - through the same
    // executor, so on Postgres it is the claim's own transaction that reads it.
    // `count(*)` comes back as a string there and a number on SQLite, hence the
    // conversion rather than a bare comparison.
    const counted = await executor.rows<{ total: number | string }>(
      sql`select count(*) as total from ${plan} where user_id = ${row.userId}`,
    );
    return Number(counted[0]?.total ?? 0) >= maxPlans ? "quota" : "duplicate";
  });
}

/** Reading and setting who may see a plan. */
function accessMethods(
  dialect: Dialect,
): Pick<
  PlanRepo,
  "findAccess" | "hasGrant" | "setVisibility" | "setShareCodeHash"
> {
  const { plan, planGrant } = dialect.tables;
  return {
    async findAccess(id) {
      const rows = await dialect.rows<{
        ownerId: string;
        visibility: PlanVisibility;
        shareCodeHash: string | null;
      }>(sql`
        select user_id as "ownerId", visibility,
               share_code_hash as "shareCodeHash"
        from ${plan} where id = ${id} limit 1
      `);
      return rows[0] ?? null;
    },

    async hasGrant(planId, userId) {
      const rows = await dialect.rows<{ granted: number }>(sql`
        select 1 as granted from ${planGrant}
        where plan_id = ${planId} and user_id = ${userId}
        limit 1
      `);
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
      updateOwned(dialect, id, userId, { visibility }),

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
        dialect,
        id,
        userId,
        { shareCodeHash: hash },
        hash === null
          ? undefined
          : sql`visibility = ${"private" satisfies PlanVisibility}`,
      ),
  };
}

export function createPlanRepo(dialect: Dialect): PlanRepo {
  const { plan, planGrant } = dialect.tables;
  return {
    insert: (row, maxPlans) => claimRow(dialect, row, maxPlans),

    async listByUser(userId, limit) {
      /*
       * `exists`, not a join or a count: a plan shared with forty accounts must
       * not multiply its own row, and the column renders one word. Postgres
       * answers this as a boolean and SQLite as 0/1, so the mapping below reads
       * both the same way rather than trusting the driver.
       *
       * Indexed: `plan_grant`'s primary key is `(plan_id, user_id)` in both
       * dialects, so this reads a prefix rather than scanning - and
       * tests/schema-shape.test.ts pins that order, because a key declared the
       * other way round would still be unique and would turn every row of the
       * dashboard into a scan.
       *
       * Every column carries an explicit alias. The row type below is keyed
       * by result name, and an unaliased `p.created_at` leaves that name to
       * the driver - `findOwner` a few lines down already relies on aliasing
       * for exactly this reason.
       */
      const rows = await dialect.rows<{
        id: string;
        label: string | null;
        size: number;
        created_at: unknown;
        visibility: PlanVisibility;
        share_code_hash: string | null;
        has_grants: unknown;
      }>(sql`
        select p.id as id, p.label as label, p.size as size,
               p.created_at as created_at, p.visibility as visibility,
               p.share_code_hash as share_code_hash,
               exists (
                 select 1 from ${planGrant} g where g.plan_id = p.id
               ) as has_grants
        from ${plan} p
        where p.user_id = ${userId}
        order by p.created_at desc
        limit ${limit}
      `);
      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        size: row.size,
        createdAt: dialect.createdAt(row.created_at),
        visibility: row.visibility,
        // The hash must not escape the repo: the dashboard only needs to know
        // whether a code exists.
        hasShareCode: row.share_code_hash !== null,
        hasGrants: Boolean(row.has_grants),
      }));
    },

    async findOwner(id) {
      const rows = await dialect.rows<{ userId: string }>(sql`
        select user_id as "userId" from ${plan} where id = ${id} limit 1
      `);
      return rows[0]?.userId ?? null;
    },

    relabel: (id, userId, label) => updateOwned(dialect, id, userId, { label }),

    resize: (id, userId, size) => updateOwned(dialect, id, userId, { size }),

    async deleteOwned(id, userId) {
      const deleted = await dialect.rows<{ id: string }>(sql`
        delete from ${plan} where id = ${id} and user_id = ${userId}
        returning id
      `);
      return deleted.length > 0;
    },

    ...accessMethods(dialect),

    ...grantMethods(dialect),
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
function accountId(tables: DialectTables, account: string, email: string): SQL {
  return sql`coalesce(
    (select id from ${tables.user} where id = ${account}),
    (select id from ${tables.user} where email = ${email})
  )`;
}

/**
 * The `plan_grant` half, kept apart because it is the only part of this repo
 * that joins `user` - and because this module stays legible only while each
 * function does one thing.
 */
function grantMethods(
  dialect: Dialect,
): Pick<PlanRepo, "listGrantHandles" | "grantByHandle" | "revokeByHandle"> {
  const { plan, planGrant, user } = dialect.tables;
  return {
    async listGrantHandles(planId, ownerId) {
      const owned = await dialect.rows<{ id: string }>(sql`
        select id from ${plan}
        where id = ${planId} and user_id = ${ownerId}
        limit 1
      `);
      // Empty is a real answer; null is a refusal. The caller renders a
      // different response for each.
      if (owned.length === 0) return null;
      const rows = await dialect.rows<{ handle: string }>(sql`
        select u.name as handle from ${planGrant} g
        inner join ${user} u on u.id = g.user_id
        where g.plan_id = ${planId}
      `);
      return rows.map((r) => r.handle);
    },

    async grantByHandle(planId, ownerId, account) {
      const email = handleEmail(account);
      // One statement: the insert-select carries both the ownership check and
      // the account lookup, so nothing is read on the path that succeeds.
      const granted = await dialect.rows<{ user_id: string }>(sql`
        insert into ${planGrant} (plan_id, user_id)
        select p.id, u.id from ${plan} p, ${user} u
        where p.id = ${planId} and p.user_id = ${ownerId}
          and u.id = ${accountId(dialect.tables, account, email)}
        on conflict do nothing
        returning user_id
      `);
      if (granted.length > 0) return "granted";

      // Only on the empty path, the same "read after failure" idiom as
      // `insert`. Both present means the row already existed, which makes a
      // repeated grant idempotent rather than an error.
      const probe = await dialect.rows<{
        owned: number | null;
        uid: string | null;
      }>(sql`
        select
          (select 1 from ${plan}
            where id = ${planId} and user_id = ${ownerId}) as owned,
          ${accountId(dialect.tables, account, email)} as uid
      `);
      // Ownership first: a plan the caller does not own answers "no-plan"
      // whatever the account was, so nothing about a stranger's plan - not
      // even which of the two things they got wrong - comes back to them.
      if (!probe[0]?.owned) return "no-plan";
      if (!probe[0].uid) return "no-user";
      return "granted";
    },

    async revokeByHandle(planId, ownerId, account) {
      const email = handleEmail(account);
      const revoked = await dialect.rows<{ user_id: string }>(sql`
        delete from ${planGrant}
        where plan_id = ${planId}
          and user_id = ${accountId(dialect.tables, account, email)}
          and exists (
            select 1 from ${plan} where id = ${planId} and user_id = ${ownerId}
          )
        returning user_id
      `);
      return revoked.length > 0;
    },
  };
}
