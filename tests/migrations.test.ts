import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/**
 * What the migrations do to data that is already there.
 *
 * The driver suites migrate an empty database and then exercise the repos, so
 * every row they see was written after the last migration ran. Nothing there
 * can catch a migration that destroys rows which existed beforehand.
 *
 * The statements run inside one transaction, the way drizzle's migrator does,
 * because that is what makes `PRAGMA foreign_keys=OFF` a no-op - and a no-op
 * pragma is what turns a table rebuild into a silent cascade. The unwrapped
 * mode is run too: the two fail in opposite directions, so testing one proves
 * very little.
 */

const DIR = "drizzle/sqlite";

function migrationFiles(): { n: number; sql: string; statements: string[] }[] {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(`${DIR}/${name}`, "utf8");
      return {
        n: Number(name.slice(0, 4)),
        sql,
        statements: sql
          .split("--> statement-breakpoint")
          .map((statement) => statement.trim())
          .filter((statement) => statement !== ""),
      };
    });
}

/**
 * Applies every migration, running `seed` immediately before the one numbered
 * `seedBefore`. `wrap` decides whether that migration runs in a transaction.
 */
function migrate(
  seedBefore: number,
  seed: (db: Database) => void,
  wrap: boolean,
): Database {
  const db = new Database(":memory:");
  // Both real SQLite paths enforce foreign keys: src/db/bun-sqlite.ts sets it
  // and D1 has it on unconditionally. Without this the hazard disappears and
  // the test would be passing against a database unlike either of them.
  db.exec("PRAGMA foreign_keys = ON");

  let seeded = false;
  for (const { n, statements } of migrationFiles()) {
    const guarded = n === seedBefore;
    if (guarded) {
      seed(db);
      seeded = true;
      if (wrap) db.exec("BEGIN");
    }
    for (const statement of statements) db.exec(statement);
    if (guarded && wrap) db.exec("COMMIT");
  }
  // Renumbering a migration would otherwise leave the seed unrun and every
  // assertion below trivially true against an empty database.
  if (!seeded) {
    db.close();
    throw new Error(`no migration numbered ${seedBefore} to seed before`);
  }
  return db;
}

const count = (db: Database, table: string): number =>
  (db.query(`select count(*) as v from ${table}`).get() as { v: number }).v;

/** A plan written before gated sharing existed: no visibility, no grants. */
function seedLegacyPlan(db: Database): void {
  db.exec(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES ('owner', 'owner', 'owner@x', 0, 0, 0),
            ('guest', 'guest', 'guest@x', 0, 0, 0)`,
  );
  db.exec(`INSERT INTO plan (id, user_id, size) VALUES ('old', 'owner', 1)`);
}

describe.each([
  ["in one transaction, as drizzle runs it", true],
  ["statement by statement", false],
])("0007 against a database with rows in it (%s)", (_, wrap) => {
  /**
   * Plans written before gated sharing were world-readable. Making them
   * private would retract access their owners had already handed out, so the
   * rebuild carries them across as public while the column default - what new
   * plans get - stays private.
   */
  test("leaves an older plan public and defaults a new one private", () => {
    const db = migrate(7, seedLegacyPlan, wrap);
    db.exec(`INSERT INTO plan (id, user_id, size) VALUES ('new', 'owner', 1)`);
    expect(
      db.query(`select id, visibility from plan order by id`).all(),
    ).toEqual([
      { id: "new", visibility: "private" },
      { id: "old", visibility: "public" },
    ]);
    db.close();
  });

  test("keeps the rest of the row through the rebuild", () => {
    const db = migrate(
      7,
      (handle) => {
        seedLegacyPlan(handle);
        handle.exec(`UPDATE plan SET label = 'kept', size = 4321`);
      },
      wrap,
    );
    expect(
      db.query(`select label, size from plan where id = 'old'`).get(),
    ).toEqual({ label: "kept", size: 4321 });
    db.close();
  });

  test("leaves no scratch table behind and no broken reference", () => {
    const db = migrate(7, seedLegacyPlan, wrap);
    expect(
      db
        .query(`select name from sqlite_master where name = '__new_plan'`)
        .all(),
    ).toEqual([]);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
    db.close();
  });

  /** Both are what the rebuild was for, so both are worth asserting. */
  test("constrains visibility and cascades grants afterwards", () => {
    const db = migrate(7, seedLegacyPlan, wrap);
    expect(() =>
      db.exec(
        `INSERT INTO plan (id, user_id, size, visibility)
         VALUES ('bad', 'owner', 1, 'sneaky')`,
      ),
    ).toThrow();

    db.exec(
      `INSERT INTO plan_grant (plan_id, user_id) VALUES ('old', 'guest')`,
    );
    db.exec(`DELETE FROM plan WHERE id = 'old'`);
    expect(count(db, "plan_grant")).toBe(0);
    db.close();
  });
});

describe.each([
  ["in one transaction, as drizzle runs it", true],
  ["statement by statement", false],
])("0009 against a public plan carrying a share code (%s)", (_, wrap) => {
  /**
   * A migration is history and is asserted as written, not as the rule stands
   * now. `0009` swept the digest off public rows because at the time a public
   * plan was not allowed to carry one; issue #22 reversed that, and a flip now
   * keeps the code. Nothing here changes: the statement shipped, it ran, and
   * what it did to a database that applied it is what this pins. What the
   * migration must still not do is touch a private plan's own code, which is
   * the state the whole code-sharing feature is.
   */
  test("clears a public plan's code and keeps a private one's", () => {
    const db = migrate(
      9,
      (seeded) => {
        seedLegacyPlan(seeded);
        seeded.exec(
          `UPDATE plan SET visibility = 'public', share_code_hash = 'deadbeef'
           WHERE id = 'old'`,
        );
        seeded.exec(
          `INSERT INTO plan (id, user_id, size, visibility, share_code_hash)
           VALUES ('coded', 'owner', 1, 'private', 'cafebabe')`,
        );
      },
      wrap,
    );

    expect(
      db.query(`select id, share_code_hash from plan order by id`).all(),
    ).toEqual([
      { id: "coded", share_code_hash: "cafebabe" },
      { id: "old", share_code_hash: null },
    ]);
    db.close();
  });
});

/**
 * `<statement> <table>`, however the dialect chose to quote the name.
 *
 * The three forms are spelled out rather than wrapped in optional quotes,
 * because an optional closing quote leaves the boundary in the wrong place:
 * `` `plan` `` followed by `;` has no word boundary after the backtick, so
 * the pattern would only match by backtracking past a quote it never
 * consumed. Quote pairs also have to agree. The bare form keeps its
 * boundary, so `plan` does not match inside `plan_grant`.
 */
function named(statement: string, table: string): RegExp {
  // `IF EXISTS` / `IF NOT EXISTS` sit between the verb and the name, and
  // drizzle emits them for some statements. Optional here so this guard keeps
  // matching a migration that uses one rather than silently passing.
  return new RegExp(
    `${statement}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?` +
      `(?:\`${table}\`|"${table}"|${table}\\b)`,
    "i",
  );
}

/**
 * The ordering invariant, checked statically because no data can demonstrate
 * it yet: `plan_grant` is created after the rebuild, so there is nothing for
 * the drop to cascade to.
 *
 * A regenerated migration would put them the other way round, and the loss is
 * silent - the drop empties `plan_grant` and the migration still succeeds. If
 * a future migration has to rebuild `plan` while grants exist, it must carry
 * them across by hand; this is the test that will say so.
 */
describe("the migration set as a whole", () => {
  test("never drops `plan` while `plan_grant` exists", () => {
    let grantsExistAlready = false;
    const offenders: string[] = [];

    for (const { n, sql } of migrationFiles()) {
      // Positions, not just presence: within a single file the order of these
      // two is the whole question, and a regeneration puts them the wrong way
      // round without changing which statements are present.
      //
      // Quoting is left open. Drizzle writes backticks for SQLite today, but
      // a guard that only recognised its current style would go quiet - not
      // fail - the day it emitted `"plan"` or a bare name, which is the worst
      // way for this particular test to break.
      const dropsAt = sql.search(named("DROP TABLE", "plan"));
      const createsGrantsAt = sql.search(named("CREATE TABLE", "plan_grant"));
      const preserves = named("INSERT INTO", "plan_grant").test(sql);

      if (dropsAt !== -1 && !preserves) {
        const grantsLiveAtDrop =
          grantsExistAlready ||
          (createsGrantsAt !== -1 && createsGrantsAt < dropsAt);
        if (grantsLiveAtDrop)
          offenders.push(`${n}: drops plan under plan_grant`);
      }
      if (createsGrantsAt !== -1) grantsExistAlready = true;
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * Both dialects have to carry the data repairs, not just the schema.
 *
 * The Postgres files are applied for real by the driver fixture, so this is not
 * about whether they parse - it is about divergence. The tests above run the
 * SQLite corpus through bun:sqlite; nothing else notices if the Postgres twin of
 * a data migration was never written, or was written against the wrong column.
 */
describe("the data repairs exist in both dialects", () => {
  const corpus = (dialect: "sqlite" | "pg"): string =>
    readdirSync(`drizzle/${dialect}`)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(`drizzle/${dialect}/${name}`, "utf8"))
      .join("\n");

  test.each(["sqlite", "pg"] as const)(
    "%s clears the share code of public plans",
    (dialect) => {
      // Quoting differs between the two, so the shape is matched rather than
      // the exact text: set the digest null, for public rows.
      expect(corpus(dialect)).toMatch(
        /update\s+["`]?plan["`]?\s+set\s+["`]?share_code_hash["`]?\s*=\s*null\s+where\s+["`]?visibility["`]?\s*=\s*'public'/i,
      );
    },
  );

  test.each(["sqlite", "pg"] as const)(
    "%s drops the unlock counters keyed by a raw address",
    (dialect) => {
      // Those rows predate the switch to a keyed digest, so nothing can match
      // them again. Ephemeral counters, so they are deleted rather than
      // rewritten - and the sweep that would otherwise collect them only runs
      // on a fraction of redemptions.
      expect(corpus(dialect)).toMatch(
        /delete\s+from\s+["`]?unlock_rate_limit["`]?/i,
      );
    },
  );
});
