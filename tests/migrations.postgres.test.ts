import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { DATABASE_URL } from "./drivers/backends.ts";

/**
 * What the Postgres migrations do to data that is already there.
 *
 * tests/migrations.test.ts asks this of SQLite, through `bun:sqlite`. It cannot
 * ask it of Postgres: the dialects ship separate files, and a data repair
 * written for one is not evidence about the other. The parity assertions at the
 * end of that file prove each dialect *contains* a repair; this proves the
 * Postgres one transforms rows.
 *
 * Everything runs in a scratch schema named for this run and dropped afterwards,
 * the same containment tests/drivers/backends.ts gives the driver suites, so
 * pointing `TEST_DATABASE_URL` at a database holding a real `plan` table cannot
 * destroy it.
 */

const DIR = "drizzle/pg";
const CONNECT_TIMEOUT_MS = 5_000;
const skip = DATABASE_URL === undefined;

function migrationFiles(rewrite: (sql: string) => string) {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      n: Number(name.slice(0, 4)),
      statements: rewrite(readFileSync(`${DIR}/${name}`, "utf8"))
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement !== ""),
    }));
}

const schemas: string[] = [];

/**
 * Applies every Postgres migration, running `seed` immediately before the one
 * numbered `seedBefore`. Returns the pool, still open, for the assertions.
 */
async function migrate(
  seedBefore: number,
  seed: (run: (statement: string) => Promise<unknown>) => Promise<void>,
): Promise<pg.Pool> {
  const schema = `bunkerplan_mig_${crypto.randomUUID().replaceAll("-", "")}`;

  const bootstrap = new pg.Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await bootstrap.connect();
  await bootstrap.query(`create schema "${schema}"`);
  await bootstrap.end();
  schemas.push(schema);

  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c search_path=${schema}`,
  });
  const run = (statement: string) => pool.query(statement);

  let seeded = false;
  // Drizzle writes explicit `"public".` on its foreign keys; redirected so
  // nothing reaches the real schema, exactly as the driver fixture does.
  for (const { n, statements } of migrationFiles((body) =>
    body.replaceAll('"public".', `"${schema}".`),
  )) {
    if (n === seedBefore) {
      await seed(run);
      seeded = true;
    }
    for (const statement of statements) await run(statement);
  }
  // Renumbering a migration would otherwise leave the seed unrun and every
  // assertion below trivially true against an empty schema.
  if (!seeded) {
    await pool.end();
    throw new Error(`no migration numbered ${seedBefore} to seed before`);
  }
  return pool;
}

afterAll(async () => {
  if (schemas.length === 0) return;
  const bootstrap = new pg.Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await bootstrap.connect();
  for (const schema of schemas) {
    await bootstrap.query(`drop schema if exists "${schema}" cascade`);
  }
  await bootstrap.end();
});

describe.skipIf(skip)("0010 against rows already stored", () => {
  test("clears a public plan's share code and keeps a private one's", async () => {
    const pool = await migrate(10, async (run) => {
      await run(
        `insert into "user" (id, name, email, email_verified, created_at, updated_at)
         values ('owner', 'owner', 'owner@x', false, now(), now())`,
      );
      // The shape written before public retired the code, and the shape the
      // whole code-sharing feature is, side by side.
      await run(
        `insert into plan (id, user_id, size, visibility, share_code_hash)
         values ('legacy', 'owner', 1, 'public', 'deadbeef'),
                ('coded', 'owner', 1, 'private', 'cafebabe')`,
      );
    });

    const { rows } = await pool.query<{ id: string; hash: string | null }>(
      `select id, share_code_hash as hash from plan order by id`,
    );
    await pool.end();

    expect(rows).toEqual([
      { id: "coded", hash: "cafebabe" },
      { id: "legacy", hash: null },
    ]);
  });
});

describe.skipIf(skip)("0011 against rows already stored", () => {
  test("drops unlock counters keyed by a raw address", async () => {
    const pool = await migrate(11, async (run) => {
      await run(
        `insert into unlock_rate_limit (key, count, window_start)
         values ('203.0.113.9', 2, ${Date.now()})`,
      );
    });

    // Keyed by an address, so nothing can match them once the key is a digest.
    const { rows } = await pool.query<{ v: string }>(
      `select count(*) as v from unlock_rate_limit`,
    );
    await pool.end();

    expect(Number(rows[0]?.v)).toBe(0);
  });
});
