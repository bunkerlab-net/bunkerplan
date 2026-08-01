import { type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Dialect, SqlExecutor } from "./dialect.ts";
import * as accountClosingSchema from "./schema/account-closing.pg.ts";
import * as authSchema from "./schema/auth.pg.ts";
import * as planSchema from "./schema/plan.pg.ts";
import * as rateLimitSchema from "./schema/rate-limit.pg.ts";
import {
  DatabaseUnavailable,
  isLockUnavailable,
  isPoolTimeout,
  isStatementCancelled,
} from "./unavailable.ts";

export const pgSchema = {
  ...authSchema,
  ...planSchema,
  ...rateLimitSchema,
  ...accountClosingSchema,
};

export type PgSchema = typeof pgSchema;

export type PgDb = NodePgDatabase<PgSchema>;

/**
 * The two calls every Postgres statement goes through, over whichever handle
 * issues it: the pool for an ordinary read, the transaction inside `claim`.
 *
 * node-postgres types the rows through drizzle's `Assume<T, QueryResultRow>`;
 * the cast only removes that wrapper, `T` already is the row shape the caller
 * declared.
 */
function pgExecutor(handle: Pick<PgDb, "execute">): SqlExecutor {
  return {
    async rows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
      return (await handle.execute(query)).rows as T[];
    },
    async run(query: SQL): Promise<void> {
      await handle.execute(query);
    },
  };
}

/**
 * The advisory-lock key for an account, as a signed 64-bit integer.
 *
 * Derived here rather than by `hashtext()` on the server. Two reasons, and
 * neither is the lock behaving differently: `hashtext` is an internal function
 * Postgres documents nowhere and has changed its output across major versions
 * before, and it is 32-bit, so two accounts collide roughly every 65,000 -
 * which costs only serialisation, but costs it for no reason when the full
 * width is free.
 *
 * The first eight bytes of a SHA-256, read big-endian and reinterpreted as
 * signed, because that is what `bigint` is: `pg_advisory_xact_lock` takes one
 * key of that type and `pg` sends a `bigint` as a decimal string, so the
 * conversion has to happen before the value leaves here.
 *
 * Changing this derivation is safe to deploy, because the locks are
 * transaction-scoped and hold nothing across a restart - but during a rolling
 * deploy two nodes would key the same account differently and could each admit
 * a claim at the ceiling. One plan over quota, once, for the length of a
 * rollout.
 */
async function lockKey(userId: string): Promise<bigint> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(userId),
  );
  const unsigned = new DataView(digest).getBigUint64(0);
  return BigInt.asIntN(64, unsigned);
}

/**
 * Count-and-claim as one critical section per account.
 *
 * Postgres reads the count from its snapshot, so unlike SQLite - which
 * serialises writers for us - two concurrent claims at `maxPlans - 1` would
 * both see room and both write. The advisory lock is what makes that one
 * section, and it is released with the transaction whichever way it ends. The
 * body reads and writes through the transaction, which is the only reason the
 * executor is handed to it.
 *
 * The lock is only half of it. The count must also see what the previous
 * holder committed, and only read committed does: it takes a fresh snapshot
 * per statement, so the count issued after the lock is granted sees the row
 * the last holder wrote. Repeatable read and serializable read the whole
 * transaction from one snapshot taken before the wait, so the second claimant
 * counts the account as it stood before the first one wrote, and the ceiling
 * admits one plan too many per waiter.
 *
 * Stated on the transaction rather than left to the server, because the
 * server's answer is `default_transaction_isolation` - a `postgresql.conf`
 * line or an `options=` parameter on `DATABASE_URL`, neither of which this
 * deployment controls, and both of which would loosen the quota while reading
 * like a tightening. `begin isolation level read committed` says what this
 * needs, on a statement nobody can configure out from under it.
 *
 * Two accounts can still land on one lock, since 64 bits is a key space and
 * not a guarantee. That costs serialisation and nothing else: the lock only
 * decides who counts and claims at a time, and `claimRow` still filters its
 * count by `user_id`, so a collided pair sees its own quota either way. They
 * wait for each other's claim - a claim being one short statement - and at
 * 2^64 that is rare enough to be cheaper than a lock table keyed by the id
 * itself. See `lockKey` below for where the number comes from.
 *
 * Waiting for that lock is itself a statement, so `statement_timeout` bounds
 * it and a queue deep enough ends in a cancellation rather than a hang. That
 * is the one cancellation worth naming, and it is caught around that statement
 * alone rather than around the whole transaction. Two reasons. A `57014`
 * caught outside `db.transaction` may have landed on the `COMMIT` - the
 * timeout stays armed through the transaction commands - and whether that
 * committed is then unknown, which is the one thing a retryable answer may not
 * be unsure about. And a cancellation from inside `body` is a different event
 * that happens to share a code; calling it lock contention would be a guess.
 *
 * Thrown from inside the callback so drizzle rolls the transaction back on the
 * way out. Nothing was claimed - the lock is the first statement, before any
 * write - so the retry is safe on the plainest possible grounds.
 *
 * `lock_timeout` bounds that wait on its own, ahead of the pool-wide
 * `statement_timeout` which stays where it is for ordinary statements. Two
 * things come of it. A queue deep enough to be hopeless gives its connection
 * back in seconds rather than holding a pool slot for the full statement
 * deadline, which matters because `POOL_MAX` waiters on one account is the
 * whole pool. And it raises `55P03` (`lock_not_available`), which says
 * contention exactly, where `57014` only says something here was cancelled.
 * Both are translated, because both leave the transaction aborted with nothing
 * written; the distinction is for whoever reads the log, not the caller.
 *
 * The pool refusing to hand out a client is the other one, and is caught
 * outside: it happens before a transaction exists at all. All are translated
 * here because this is the last place that knows it is Postgres; `pg` must not
 * be reachable from the handler that answers.
 */
function pgClaim(db: PgDb): Dialect["claim"] {
  return async (userId, body) => {
    try {
      return await db.transaction(
        async (tx) => {
          try {
            // Transaction-local: `set local` reverts with the transaction, so
            // the connection goes back to the pool with the ordinary deadline.
            await tx.execute(sql`set local lock_timeout = '3s'`);
            await tx.execute(
              sql`select pg_advisory_xact_lock(${await lockKey(userId)})`,
            );
          } catch (cause) {
            if (isLockUnavailable(cause) || isStatementCancelled(cause)) {
              throw new DatabaseUnavailable("waiting to claim a plan id", {
                cause,
              });
            }
            throw cause;
          }
          return await body(pgExecutor(tx));
        },
        { isolationLevel: "read committed" },
      );
    } catch (cause) {
      if (isPoolTimeout(cause)) {
        throw new DatabaseUnavailable("connecting to claim a plan id", {
          cause,
        });
      }
      throw cause;
    }
  };
}

/**
 * The Postgres half of the repository seam - see src/db/dialect.ts for what
 * each member is for.
 */
export function pgDialect(db: PgDb): Dialect {
  const executor = pgExecutor(db);
  return {
    ...executor,
    tables: {
      plan: planSchema.plan,
      planGrant: planSchema.planGrant,
      user: authSchema.user,
      accountClosing: accountClosingSchema.accountClosing,
      uploadRateLimit: rateLimitSchema.uploadRateLimit,
      unlockRateLimit: rateLimitSchema.unlockRateLimit,
    },

    claim: pgClaim(db),

    // Drizzle asks node-postgres to leave timestamps as the strings Postgres
    // sent, so the column's own mapper is what reads one - which is also what
    // keeps a `timestamp` column without a zone being read as UTC rather than
    // as the server's local time. The cast only names what that mapper
    // returns, which the column's declared type already fixes.
    createdAt: (value) =>
      planSchema.plan.createdAt.mapFromDriverValue(value) as Date,

    floor: (expr) => sql`greatest(${expr}, 0)`,
  };
}

/**
 * The `Db` fields `src/auth/instance.ts` hands to `drizzleAdapter`, narrowed to
 * the drizzle instance this dialect actually holds. See `SqliteAuthHandle` in
 * src/db/sqlite-shared.ts for why the pairing is a type rather than a comment.
 */
export type PgAuthHandle = { adapter: PgDb; provider: "pg" };
