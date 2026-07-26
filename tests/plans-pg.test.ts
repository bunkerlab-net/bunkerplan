import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

async function seedUser(): Promise<string> {
  const id = `u-${crypto.randomUUID()}`;
  await db.execute(sql`insert into "user" (id) values (${id})`);
  return id;
}

const newRow = (userId: string) => ({
  id: `p-${crypto.randomUUID()}`,
  userId,
  label: null,
  size: 1,
});

describe.skipIf(DATABASE_URL === undefined)("createPgPlanRepo quota", () => {
  beforeAll(async () => {
    const bootstrap = new pg.Client({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    // No try/catch: an unreachable server must fail the suite, not skip it.
    await bootstrap.connect();
    await bootstrap.query(`create schema "${SCHEMA}"`);
    await bootstrap.end();

    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 5000,
      options: `-c search_path=${SCHEMA}`,
    });
    db = drizzle(pool);

    // Only the columns the repo touches. The foreign key is reproduced because
    // it is what makes a plan row depend on its owner, which the quota counts.
    await db.execute(sql`
      create table "user" (id text primary key);
      create table plan (
        id text primary key,
        user_id text not null references "user"(id) on delete cascade,
        label text,
        size integer not null,
        created_at timestamp not null default now()
      );
    `);
    plans = createPgPlanRepo(db);
  });

  afterAll(async () => {
    await pool?.query(`drop schema if exists "${SCHEMA}" cascade`);
    await pool?.end();
  });

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
