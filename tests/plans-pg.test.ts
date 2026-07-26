import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { PgSchema } from "../src/db/pg-shared.ts";
import { createPgPlanRepo } from "../src/db/plans.pg.ts";
import type { PlanRepo } from "../src/services/types.ts";

/**
 * The Worker e2e suite runs on D1, where SQLite serialises writers and makes
 * the count inside the claiming statement atomic for free. Postgres does not:
 * under READ COMMITTED two concurrent claims evaluate the count against their
 * own snapshot, so the ceiling there is held by an advisory lock instead. That
 * lock only exists against a real server, which is what this suite is for.
 *
 * Opt-in by `TEST_DATABASE_URL`, and once opted in it fails rather than skips:
 * a suite that reports success because it could not reach a server is worse
 * than no suite. Without the variable the tests are reported as skipped, so
 * their absence is visible rather than silent.
 *
 * Everything is created inside a scratch schema named for this run and dropped
 * afterwards, so pointing the variable at a database that already has a `plan`
 * table cannot destroy it.
 */
const DATABASE_URL = process.env["TEST_DATABASE_URL"];
const SCHEMA = `bunkerplan_test_${crypto.randomUUID().replaceAll("-", "")}`;

let pool: pg.Pool;
let db: NodePgDatabase<PgSchema>;
let plans: PlanRepo;

async function seedUser(prefix = "u"): Promise<string> {
  const id = `${prefix}-${crypto.randomUUID()}`;
  await db.execute(
    sql`insert into "user" (id, name, email, email_verified, created_at, updated_at)
        values (${id}, ${id}, ${`${id}@example.test`}, false, now(), now())`,
  );
  return id;
}

const newRow = (userId: string) => ({
  id: `p-${crypto.randomUUID()}`,
  userId,
  label: null,
  size: 1,
});

/**
 * The SQLSTATE a `pg` driver error carries, if it is one. Drizzle wraps the
 * driver error, so the code lives on `cause` rather than the thrown error.
 * Narrowed rather than asserted: nothing here has verified the shape.
 */
function pgErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("cause" in error)) return undefined;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }
  return typeof cause.code === "string" ? cause.code : undefined;
}

beforeAll(async () => {
  if (DATABASE_URL === undefined) return;

  const bootstrap = new pg.Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  // No try/catch: once opted in, an unreachable server must fail the suite
  // rather than let it report success against nothing.
  await bootstrap.connect();
  await bootstrap.query(`create schema "${SCHEMA}"`);
  await bootstrap.end();

  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5000,
    options: `-c search_path=${SCHEMA}`,
  });
  db = drizzle(pool);

  // The real migrations, so this exercises the artifacts that ship rather than
  // a hand-written approximation of them. `search_path` places every
  // unqualified `create` in the scratch schema; drizzle also emits explicit
  // `"public".` references on its foreign keys, which are redirected the same
  // way so nothing reaches the real schema.
  const dir = new URL("../drizzle/pg", import.meta.url).pathname;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const statements = readFileSync(`${dir}/${file}`, "utf8")
      .replaceAll('"public".', `"${SCHEMA}".`)
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    for (const statement of statements) await db.execute(sql.raw(statement));
  }
  plans = createPgPlanRepo(db);
});

afterAll(async () => {
  await pool?.query(`drop schema if exists "${SCHEMA}" cascade`);
  await pool?.end();
});

describe.skipIf(DATABASE_URL === undefined)("createPgPlanRepo quota", () => {
  test("reports created, duplicate, and quota distinctly", async () => {
    const userId = await seedUser();
    const row = newRow(userId);

    expect(await plans.insert(row, 5)).toBe("created");
    // Same id again: a collision, which the caller retries with a fresh id.
    expect(await plans.insert(row, 5)).toBe("duplicate");
    // Ceiling already reached, which the caller must not retry into.
    expect(await plans.insert(newRow(userId), 1)).toBe("quota");
  });

  /**
   * The regression this file exists for. Without the advisory lock every
   * concurrent claim at the boundary reads the same count and writes.
   */
  test("admits exactly the ceiling when claims race", async () => {
    const userId = await seedUser();
    const limit = 5;
    const attempts = 40;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        plans.insert(newRow(userId), limit),
      ),
    );

    expect(results.filter((r) => r === "created")).toHaveLength(limit);
    expect(results.filter((r) => r === "quota")).toHaveLength(attempts - limit);

    const rows = await db.execute<{ total: string }>(
      sql`select count(*) as total from plan where user_id = ${userId}`,
    );
    expect(Number(rows.rows[0]?.total)).toBe(limit);
  });

  test("counts each account separately", async () => {
    const [a, b] = [await seedUser(), await seedUser()];
    expect(await plans.insert(newRow(a), 1)).toBe("created");
    // b is untouched by a filling its own allowance.
    expect(await plans.insert(newRow(b), 1)).toBe("created");
  });

  test("frees a slot when a plan is deleted", async () => {
    const userId = await seedUser();
    const row = newRow(userId);

    expect(await plans.insert(row, 1)).toBe("created");
    expect(await plans.insert(newRow(userId), 1)).toBe("quota");
    expect(await plans.deleteOwned(row.id, userId)).toBe(true);
    expect(await plans.insert(newRow(userId), 1)).toBe("created");
  });
});

/**
 * The Postgres migration is a separate generated artifact from the SQLite one,
 * so the constraint has to be proved on both. A shared credential id makes the
 * sign-in lookup non-deterministic, and registration takes no attestation, so
 * the id is chosen by whoever registers.
 */
describe.skipIf(DATABASE_URL === undefined)("passkey credential ids", () => {
  // `async` rather than returning `db.execute(...)` directly: drizzle hands
  // back a thenable builder, and `.rejects` requires a real promise.
  const addPasskey = async (userId: string, credentialId: string) => {
    await db.execute(
      sql`insert into passkey
            (id, public_key, user_id, credential_id, counter, device_type, backed_up)
          values (${`pk-${crypto.randomUUID()}`}, 'pk', ${userId}, ${credentialId},
                  0, 'singleDevice', false)`,
    );
  };

  test("cannot be claimed twice, even by a different account", async () => {
    const victim = await seedUser("victim");
    const attacker = await seedUser("attacker");

    const credentialId = `cred-${crypto.randomUUID()}`;
    await addPasskey(victim, credentialId);

    // Asserted on the driver's code rather than a message: drizzle wraps the
    // error as "Failed query", so matching text would pass for any failure,
    // and `23505` is specifically a unique violation.
    const failure: unknown = await addPasskey(attacker, credentialId).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(pgErrorCode(failure)).toBe("23505");
  });

  test("still allows one account to hold several distinct credentials", async () => {
    const owner = await seedUser("owner");
    await addPasskey(owner, `cred-${crypto.randomUUID()}`);
    await addPasskey(owner, `cred-${crypto.randomUUID()}`);
    const rows = await db.execute<{ total: string }>(
      sql`select count(*) as total from passkey where user_id = ${owner}`,
    );
    expect(Number(rows.rows[0]?.total)).toBe(2);
  });
});
