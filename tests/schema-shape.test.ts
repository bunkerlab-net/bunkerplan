import { describe, expect, test } from "bun:test";
import {
  createTableRelationsHelpers,
  getTableName,
  is,
  type Relation,
  Relations,
  SQL,
  type Table,
} from "drizzle-orm";
import {
  PgDialect,
  PgTable,
  getTableConfig as pgTableConfig,
} from "drizzle-orm/pg-core";
import {
  SQLiteSyncDialect,
  SQLiteTable,
  getTableConfig as sqliteTableConfig,
} from "drizzle-orm/sqlite-core";
import * as pgAccountClosing from "../src/db/schema/account-closing.pg.ts";
import * as sqliteAccountClosing from "../src/db/schema/account-closing.sqlite.ts";
import * as pgAuth from "../src/db/schema/auth.pg.ts";
import * as sqliteAuth from "../src/db/schema/auth.sqlite.ts";
import * as pgPlan from "../src/db/schema/plan.pg.ts";
import * as sqlitePlan from "../src/db/schema/plan.sqlite.ts";
import * as pgRateLimit from "../src/db/schema/rate-limit.pg.ts";
import * as sqliteRateLimit from "../src/db/schema/rate-limit.sqlite.ts";

/**
 * The application tables, as drizzle-kit sees them.
 *
 * These files are the input every migration is generated from, so a constraint
 * that is missing here is missing from the database - and nothing fails until
 * the row it was protecting appears. Two of them are load-bearing beyond
 * ordinary hygiene:
 *
 *  - Every table keyed by a user id cascades from `user`. Nothing prunes these
 *    tables, so without it a deleted account leaves counters, grants, and a
 *    closing marker behind for good.
 *  - `unlock_rate_limit` deliberately does NOT cascade, because its key is a
 *    digest of a client address rather than a user id. It carries an index on
 *    `window_start` instead, which is what its own sweep deletes by.
 *
 * Asserted against both dialects, because the two files are written by hand
 * from the same intent and drift silently: a deployment on Postgres and one on
 * SQLite would then enforce different rules.
 */

interface Shape {
  name: string;
  columns: Array<{
    name: string;
    notNull: boolean;
    primary: boolean;
    type: string;
    /** Rendered default, or "-" for a column that has none. */
    default: string;
  }>;
  primaryKey: string[];
  indexes: Array<{ unique: boolean; columns: string[] }>;
  foreignKeys: Array<{
    columns: string[];
    references: string[];
    onDelete: string;
    onUpdate: string;
  }>;
  checks: Array<{ name: string; value: string }>;
  /**
   * Empty in every table today. Compared anyway: a unique constraint added to
   * one dialect and not the other is a rule the database enforces on Postgres
   * and not on SQLite, which is exactly the drift this file exists to catch.
   */
  uniqueConstraints: Array<{ name: string | undefined; columns: string[] }>;
}

/**
 * Renders a constraint's SQL the way its own dialect would.
 *
 * `String(sql)` gives "[object Object]" - drizzle's `SQL` has no `toString` -
 * so a check compared that way is identical to every other check and the
 * comparison proves nothing. Both dialects happen to render the expressions
 * here the same, which is what makes them comparable across the two.
 */
const renderSql = (dialect: "pg" | "sqlite", value: unknown): string =>
  dialect === "pg"
    ? new PgDialect().sqlToQuery(value as never).sql
    : new SQLiteSyncDialect().sqlToQuery(value as never).sql;

/** A drizzle `SQL` default, as opposed to a literal one. */
const isSqlDefault = (value: unknown): boolean => is(value, SQL);

/**
 * Where the two dialects are meant to disagree, both sides written out.
 *
 * An instant is a `timestamp` defaulting to `now()` on Postgres and epoch
 * millis in an `integer` on SQLite; a millisecond count is `bigint` against
 * `integer`. Recorded as pairs rather than folded into a normaliser, because a
 * normaliser loose enough to call these equal also calls `text` equal to
 * `integer`. A difference not written here fails the comparison, and one
 * written here that no longer holds fails on the way in.
 */
const DIALECT_DIFFERENCES: Record<
  string,
  Record<"pg" | "sqlite", { type: string; default: string }>
> = {
  "plan.created_at": {
    pg: { type: "timestamp", default: "now()" },
    sqlite: {
      type: "integer",
      default: "(cast(unixepoch('subsecond') * 1000 as integer))",
    },
  },
  "plan_grant.created_at": {
    pg: { type: "timestamp", default: "now()" },
    sqlite: {
      type: "integer",
      default: "(cast(unixepoch('subsecond') * 1000 as integer))",
    },
  },
  "upload_rate_limit.window_start": {
    pg: { type: "bigint", default: "-" },
    sqlite: { type: "integer", default: "-" },
  },
  "unlock_rate_limit.window_start": {
    pg: { type: "bigint", default: "-" },
    sqlite: { type: "integer", default: "-" },
  },
  "account_closing.started_at": {
    pg: { type: "bigint", default: "-" },
    sqlite: { type: "integer", default: "-" },
  },
};

/**
 * Collapses a recorded difference to one token, having first checked it is
 * still the difference that was recorded.
 */
const canonical = (
  table: string,
  dialect: "pg" | "sqlite",
  columns: Shape["columns"],
): Shape["columns"] =>
  columns.map((column) => {
    const key = `${table}.${column.name}`;
    const recorded = DIALECT_DIFFERENCES[key];
    if (recorded === undefined) return column;

    // Named, because this runs inside a `map` over every column: without it a
    // failure says two shapes differ and leaves the reader to find which one.
    expect({ type: column.type, default: column.default }, key).toEqual(
      recorded[dialect],
    );
    return { ...column, type: "(recorded)", default: "(recorded)" };
  });

/**
 * A total order over whole records.
 *
 * Sorting on the columns alone leaves siblings that share them - a plain index
 * and a unique one over the same pair, two foreign keys from the same column
 * with different `onDelete` - in whatever order they were declared. The
 * comparison below pairs the two dialects positionally, so that is enough to
 * pair one dialect's entry against the other's sibling and call a match a
 * drift, or the reverse. Every field is in the key because every field is one
 * the comparison reads.
 */
const byRecord = (a: unknown, b: unknown): number => {
  // Codepoint order, not `localeCompare`: that collates, so two distinct
  // records can compare equal and sort into whichever order they arrived in -
  // which is the non-determinism this exists to remove.
  const [left, right] = [JSON.stringify(a), JSON.stringify(b)];
  return left < right ? -1 : left > right ? 1 : 0;
};

/** One comparable description per table, from either dialect's config. */
function shapeOf(dialect: "pg" | "sqlite", table: Table): Shape {
  const config =
    dialect === "pg"
      ? pgTableConfig(table as never)
      : sqliteTableConfig(table as never);

  /*
   * Order matters inside a composite key - it decides which prefix lookups the
   * index behind it can serve - so each constraint keeps the order it was
   * declared in, joined into one token. Only the constraints are sorted against
   * each other, which is what makes two dialects comparable without pretending
   * their column order is interchangeable.
   */
  const composite = config.primaryKeys
    .map((key) => key.columns.map((column) => column.name).join(","))
    .sort();
  const inline = config.columns
    .filter((column) => column.primary)
    .map((column) => column.name)
    .sort();

  return {
    name: getTableName(table),
    columns: config.columns
      .map((column) => ({
        name: column.name,
        notNull: column.notNull,
        primary: column.primary,
        // A column retyped on one dialect stores something the other cannot,
        // and a default present on one side is a row the two write differently.
        type: column.getSQLType(),
        default: column.hasDefault
          ? isSqlDefault(column.default)
            ? renderSql(dialect, column.default)
            : JSON.stringify(column.default)
          : "-",
      }))
      .sort(byRecord),
    primaryKey: [...composite, ...inline],
    indexes: config.indexes
      .map((index) => ({
        // The `unique` flag is the rule the database enforces. Without it an
        // index that stopped being unique on one dialect reads as no drift.
        unique: index.config.unique === true,
        // An expression index has no `name`. Rendered rather than flattened to
        // "?", so two different expressions stay two different things - the
        // fallback made every one of them compare equal.
        columns: (index.config.columns as Array<{ name?: string }>).map(
          (column) => column.name ?? renderSql(dialect, column),
        ),
      }))
      .sort(byRecord),
    foreignKeys: config.foreignKeys
      .map((key) => {
        const reference = key.reference();
        return {
          columns: reference.columns.map((column) => column.name),
          references: reference.foreignColumns.map(
            (column) => `${getTableName(column.table)}.${column.name}`,
          ),
          // `?? "no action"` on both: that is the SQL default, and Drizzle's
          // pg config records it explicitly where the SQLite one leaves it
          // unset. Comparing the spellings would report drift on every foreign
          // key in the schema; comparing the meanings still catches one side
          // saying `cascade` where the other says nothing.
          onDelete: key.onDelete ?? "no action",
          onUpdate: key.onUpdate ?? "no action",
        };
      })
      .sort(byRecord),
    // Name and expression both: two dialects can agree on what a constraint is
    // called while disagreeing on what it permits.
    checks: config.checks
      .map((check) => ({
        name: check.name,
        value: renderSql(dialect, check.value),
      }))
      .sort(byRecord),
    uniqueConstraints: config.uniqueConstraints
      .map((unique) => ({
        name: unique.name,
        columns: unique.columns.map((column) => column.name),
      }))
      .sort(byRecord),
  };
}

const tables = [
  ["plan", pgPlan.plan, sqlitePlan.plan],
  ["plan_grant", pgPlan.planGrant, sqlitePlan.planGrant],
  [
    "upload_rate_limit",
    pgRateLimit.uploadRateLimit,
    sqliteRateLimit.uploadRateLimit,
  ],
  [
    "unlock_rate_limit",
    pgRateLimit.unlockRateLimit,
    sqliteRateLimit.unlockRateLimit,
  ],
  [
    "account_closing",
    pgAccountClosing.accountClosing,
    sqliteAccountClosing.accountClosing,
  ],
] as const;

describe.each(tables)("%s", (name, pg, sqlite) => {
  /*
   * Lazy, not a value computed in the `describe` body: `shapeOf` reads a
   * dialect's table config, and one that threw during collection would take
   * the whole file down with a stack pointing at no test in particular.
   * Called inside each test, the failure lands on the case that provoked it.
   */
  const shapeFor = (dialect: "pg" | "sqlite") =>
    dialect === "pg" ? shapeOf("pg", pg) : shapeOf("sqlite", sqlite);

  test("is named the same in both dialects", () => {
    expect((["pg", "sqlite"] as const).map((d) => shapeFor(d).name)).toEqual([
      name,
      name,
    ]);
  });

  test("the two dialects have not drifted", () => {
    const [fromPg, fromSqlite] = [shapeFor("pg"), shapeFor("sqlite")];
    // Whole records, not just names: `notNull`, `primary`, the SQL type and the
    // default are all rules the database enforces, and any of them holding on
    // one dialect and not the other is the drift this file exists to catch.
    expect(canonical(name, "sqlite", fromSqlite.columns)).toEqual(
      canonical(name, "pg", fromPg.columns),
    );
    expect(fromSqlite.primaryKey).toEqual(fromPg.primaryKey);
    expect(fromSqlite.foreignKeys).toEqual(fromPg.foreignKeys);
    expect(fromSqlite.indexes).toEqual(fromPg.indexes);
    expect(fromSqlite.checks).toEqual(fromPg.checks);
    expect(fromSqlite.uniqueConstraints).toEqual(fromPg.uniqueConstraints);
  });

  test.each(["pg", "sqlite"] as const)(
    "%s marks every column that cannot be null",
    (dialect) => {
      const shape = shapeFor(dialect);
      // Sorted: the order here is whatever order the column record happens to
      // enumerate in, which is not part of the schema's meaning. The set is.
      const nullable = shape.columns
        .filter((column) => !column.notNull && !column.primary)
        .map((column) => column.name)
        .sort();

      // `label` and `share_code_hash` are the only optional values in the
      // application tables; everything else is required at write time.
      expect(nullable).toEqual(
        name === "plan" ? ["label", "share_code_hash"] : [],
      );
    },
  );
});

/*
 * A recorded difference is only checked when a column of that name is found, so
 * renaming or dropping one leaves its entry unconsulted - and the claim on
 * `DIALECT_DIFFERENCES`, that an entry which no longer holds fails on the way
 * in, would quietly stop being true. An allowlist nothing reads is the kind that
 * grows.
 */
describe("the recorded dialect differences", () => {
  test("are all still reached by a column", () => {
    // Walked here rather than collected from the suites above: a test that only
    // passes when its neighbours ran first fails alone under `-t`.
    const reached = new Set<string>();
    for (const [name, pg, sqlite] of tables) {
      for (const [dialect, table] of [
        ["pg", pg],
        ["sqlite", sqlite],
      ] as const) {
        for (const column of shapeOf(dialect, table).columns) {
          const key = `${name}.${column.name}`;
          if (key in DIALECT_DIFFERENCES) reached.add(key);
        }
      }
    }

    expect([...reached].sort()).toEqual(
      Object.keys(DIALECT_DIFFERENCES).sort(),
    );
  });
});

describe("cascading from the account", () => {
  const cascading = [
    ["plan", "user_id", "user.id", pgPlan.plan, sqlitePlan.plan],
    [
      "plan_grant",
      "user_id",
      "user.id",
      pgPlan.planGrant,
      sqlitePlan.planGrant,
    ],
    /*
     * The other half of a grant. Deleting a plan must take its grants with it,
     * or a later plan minted with a recycled id would inherit them - and the
     * read gate would hand that document to accounts the new owner never named.
     */
    [
      "plan_grant",
      "plan_id",
      "plan.id",
      pgPlan.planGrant,
      sqlitePlan.planGrant,
    ],
    [
      "upload_rate_limit",
      "key",
      "user.id",
      pgRateLimit.uploadRateLimit,
      sqliteRateLimit.uploadRateLimit,
    ],
    [
      "account_closing",
      "user_id",
      "user.id",
      pgAccountClosing.accountClosing,
      sqliteAccountClosing.accountClosing,
    ],
  ] as const;

  // The column is the second element so `%s.%s` names `table.column`; with the
  // tables there the title interpolated a Drizzle object.
  test.each(cascading)(
    "%s.%s goes with %s",
    (_name, column, references, pg, sqlite) => {
      for (const [dialect, table] of [
        ["pg", pg],
        ["sqlite", sqlite],
      ] as const) {
        // Nothing prunes these tables, so without the cascade a deleted row
        // leaves its dependents behind for good.
        expect(shapeOf(dialect, table).foreignKeys).toContainEqual({
          columns: [column],
          references: [references],
          onDelete: "cascade",
          // The SQL default, normalised above: ids here are immutable, so no
          // dialect has ever been asked what an update should do. Pinned so
          // that one side gaining a rule shows up as the drift it is.
          onUpdate: "no action",
        });
      }
    },
  );

  test.each([
    ["pg", pgRateLimit.unlockRateLimit],
    ["sqlite", sqliteRateLimit.unlockRateLimit],
  ] as const)(
    "unlock_rate_limit in %s deliberately does not",
    (dialect, table) => {
      const shape = shapeOf(dialect, table);

      // Its key is a keyed digest of a client address, so there is no row for
      // a foreign key to hang from.
      expect(shape.foreignKeys).toEqual([]);
      // It sweeps itself by window instead, which is what this index is for.
      expect(shape.indexes).toEqual([
        { unique: false, columns: ["window_start"] },
      ]);
    },
  );
});

describe("the plan table", () => {
  test.each([
    ["pg", pgPlan.plan],
    ["sqlite", sqlitePlan.plan],
  ] as const)(
    "%s constrains visibility in the database, not only in types",
    (dialect, table) => {
      // `$type` is a compile-time claim and the repo is not the only writer: a
      // migration or a console session can put anything in this column.
      // The expression too, not just the name: a check called the right thing
      // that permits anything is the failure this guards against.
      expect(shapeOf(dialect, table).checks).toEqual([
        {
          name: "plan_visibility_check",
          value: `"visibility" in ('public', 'private')`,
        },
      ]);
    },
  );

  test.each([
    ["pg", pgPlan.plan],
    ["sqlite", sqlitePlan.plan],
  ] as const)(
    "%s indexes the owner, which is how the dashboard lists",
    (dialect, table) => {
      expect(shapeOf(dialect, table).indexes).toContainEqual({
        unique: false,
        columns: ["user_id"],
      });
    },
  );

  test.each([
    ["pg", pgPlan.planGrant],
    ["sqlite", sqlitePlan.planGrant],
  ] as const)(
    "%s keys a grant by the pair, so it cannot be duplicated",
    (dialect, table) => {
      // One constraint, in its declared order: `plan_id` first is what lets the
      // key's own index answer "who is this plan shared with" without a scan.
      expect(shapeOf(dialect, table).primaryKey).toEqual(["plan_id,user_id"]);
      // And indexes the grantee, which is how the read gate checks one.
      expect(shapeOf(dialect, table).indexes).toContainEqual({
        unique: false,
        columns: ["user_id"],
      });
    },
  );
});

describe("the account-closing table", () => {
  test.each([
    ["pg", pgAccountClosing.accountClosing],
    ["sqlite", sqliteAccountClosing.accountClosing],
  ] as const)(
    "%s keys a mark by the attempt, not the account",
    (dialect, table) => {
      const shape = shapeOf(dialect, table);
      /*
       * The whole point of the table's shape. Keyed by `user_id`, a second
       * deletion of one account could not place a mark of its own, and the
       * first of the two to fail would lift the only one there - ending the
       * other's protection while it was still sweeping.
       */
      expect(shape.primaryKey).toEqual(["attempt_id"]);
      // And the account is what every read asks about, so it is indexed
      // rather than scanned: `isOpen` runs on the upload path.
      expect(shape.indexes).toContainEqual({
        unique: false,
        columns: ["user_id"],
      });
    },
  );
});

/**
 * The relational metadata in the two generated auth schemas.
 *
 * `src/db/schema/auth.pg.ts` and `auth.sqlite.ts` are written by
 * `bun run auth:generate:*` rather than by hand, and each declares its
 * relations through a callback drizzle only invokes when something builds the
 * relational config. Nothing in this app does - Better Auth's adapter writes
 * its own joins - so the callbacks are the one part of those files that has
 * never run anywhere.
 *
 * Worth pinning for the same reason as everything above it: the two files must
 * agree. A regeneration against a drifted config that dropped `passkey` from
 * one side and not the other is a difference between two deployments, and it
 * would be invisible until someone reached for a relational query. Asserting
 * the shape rather than editing the files, because the generator owns them.
 */
describe("the generated auth relations", () => {
  /** Invokes the callback drizzle defers, which is the point of the file. */
  const relationsOf = (value: Relations): Record<string, Relation> =>
    value.config(createTableRelationsHelpers(value.table));

  const declared = (
    module: Record<string, unknown>,
  ): Record<string, string[]> =>
    Object.fromEntries(
      Object.entries(module)
        .filter((entry): entry is [string, Relations] =>
          is(entry[1], Relations),
        )
        .map(([name, value]) => [name, Object.keys(relationsOf(value)).sort()]),
    );

  test("both dialects declare the same relations on the same tables", () => {
    const pg = declared(pgAuth);
    const sqlite = declared(sqliteAuth);

    // Non-empty first: two modules that both stopped declaring anything would
    // otherwise agree perfectly and say nothing.
    expect(Object.keys(pg).length).toBeGreaterThan(0);
    expect(sqlite).toEqual(pg);
  });

  test.each([
    ["pg", pgAuth],
    ["sqlite", sqliteAuth],
  ] as const)(
    "%s points every relation at a real table",
    (_dialect, module) => {
      for (const value of Object.values(module)) {
        if (!is(value, Relations)) continue;
        for (const [field, relation] of Object.entries(relationsOf(value))) {
          // A relation naming a table the schema does not have is a generator
          // run against a config that no longer matches this app.
          expect(getTableName(relation.referencedTable)).toBeTruthy();
          expect(field).not.toBe("");
        }
      }
    },
  );

  /**
   * The account tables hang off `user`, which is what every cascade in this
   * file above depends on being true in the schema as well as in the database.
   */
  test.each([
    ["pg", pgAuth],
    ["sqlite", sqliteAuth],
  ] as const)(
    "%s hangs the per-account tables off user",
    (_dialect, module) => {
      for (const name of ["sessionRelations", "accountRelations"] as const) {
        const value = module[name];
        expect(is(value, Relations)).toBe(true);
        if (!is(value, Relations)) continue;

        // Named rather than asserted non-null: a relation that stopped being
        // declared should read as "missing", not as a crash on the line after.
        const toUser = relationsOf(value)["user"];
        expect(toUser, `${name} declares a user relation`).toBeDefined();
        if (toUser === undefined) continue;
        expect(getTableName(toUser.referencedTable)).toBe("user");
      }
    },
  );
});

/**
 * `updated_at`, which the generated schemas keep current rather than the
 * database doing it.
 *
 * Every one of these columns carries an `$onUpdate` that drizzle calls while
 * building an update, so the stamp is the application's job on both engines -
 * neither schema declares an `ON UPDATE` trigger, and SQLite has no such thing
 * to declare. A regeneration that dropped one would freeze that table's
 * `updated_at` at whatever the insert wrote, silently: nothing reads it in a
 * hot path, so the first symptom is a session-expiry or audit question nobody
 * can answer months later.
 *
 * Asserted through the column rather than through a write, because the
 * callback is what the two dialects have to agree on and only one of them has
 * a server to write to.
 */
describe("the updated_at stamp", () => {
  /**
   * Every stamping column in one dialect, as `table.column` plus the callback
   * itself. Narrowed with each dialect's own table class rather than the
   * shared one, because `getTableConfig` is dialect-specific and a cast to
   * get past that would be asserting exactly the thing being checked.
   */
  function pgStamps(): Array<[string, () => unknown]> {
    const found: Array<[string, () => unknown]> = [];
    for (const value of Object.values(pgAuth)) {
      if (!is(value, PgTable)) continue;
      for (const column of pgTableConfig(value).columns) {
        const onUpdate = column.onUpdateFn;
        if (onUpdate === undefined) continue;
        found.push([`${getTableName(value)}.${column.name}`, onUpdate]);
      }
    }
    return found.sort(([a], [b]) => a.localeCompare(b));
  }

  function sqliteStamps(): Array<[string, () => unknown]> {
    const found: Array<[string, () => unknown]> = [];
    for (const value of Object.values(sqliteAuth)) {
      if (!is(value, SQLiteTable)) continue;
      for (const column of sqliteTableConfig(value).columns) {
        const onUpdate = column.onUpdateFn;
        if (onUpdate === undefined) continue;
        found.push([`${getTableName(value)}.${column.name}`, onUpdate]);
      }
    }
    return found.sort(([a], [b]) => a.localeCompare(b));
  }

  // The four Better Auth keeps current. Named rather than counted, so a
  // regeneration that moved the stamp to another table reads as a difference
  // here instead of as the same total.
  const EXPECTED = [
    "account.updated_at",
    "session.updated_at",
    "user.updated_at",
    "verification.updated_at",
  ];

  test.each([
    ["pg", pgStamps],
    ["sqlite", sqliteStamps],
  ] as const)("%s stamps exactly the tables that carry one", (_d, stamps) => {
    expect(stamps().map(([name]) => name)).toEqual(EXPECTED);
  });

  test.each([
    ["pg", pgStamps],
    ["sqlite", sqliteStamps],
  ] as const)("%s stamps with the time of the update", (_d, stamps) => {
    const before = Date.now();
    const found = stamps();

    // Non-vacuous: a schema that stopped declaring any would pass the loop.
    expect(found).toHaveLength(EXPECTED.length);
    for (const [name, onUpdate] of found) {
      const stampedAt = onUpdate();
      // A `Date` on both engines: the SQLite column stores epoch millis and
      // the Postgres one a timestamp, and the conversion is the driver's.
      expect(stampedAt, name).toBeInstanceOf(Date);
      if (!(stampedAt instanceof Date)) continue;
      expect(stampedAt.getTime()).toBeGreaterThanOrEqual(before);
    }
  });
});

/**
 * The generated auth tables' cascades.
 *
 * The note at the top of this file says every table keyed by a user id
 * cascades from `user`, and the suites above check that for the four tables
 * this app wrote. The other four come out of `bun run auth:generate:*`, are
 * never edited by hand, and carry the same requirement for the same reason:
 * nothing prunes them, so a missing cascade leaves an account's sessions,
 * credentials and API keys behind after the account is gone. `passkey` is the
 * one that matters most - a row there is a credential.
 *
 * Generated does not mean exempt. The generator reads a config in
 * `src/db/gen/`, and a change there - or a Better Auth release that revises
 * its schema - lands here with nothing else failing.
 */
describe("the generated auth tables", () => {
  /*
   * The owning column, per table. `apikey` names it `reference_id` rather
   * than `user_id` - the plugin's own column name - and spelling that out is
   * the point: a table whose owner column got renamed by a regeneration would
   * otherwise read as a table with no cascade at all.
   */
  const CASCADING = [
    ["session", "user_id", pgAuth.session, sqliteAuth.session],
    ["account", "user_id", pgAuth.account, sqliteAuth.account],
    ["passkey", "user_id", pgAuth.passkey, sqliteAuth.passkey],
    ["apikey", "reference_id", pgAuth.apikey, sqliteAuth.apikey],
  ] as const;

  test.each(CASCADING)(
    "%s cascades from user on both dialects",
    (_name, column, pgTable, sqliteTable) => {
      for (const [dialect, table] of [
        ["pg", pgTable],
        ["sqlite", sqliteTable],
      ] as const) {
        expect(shapeOf(dialect, table).foreignKeys).toContainEqual({
          columns: [column],
          references: ["user.id"],
          onDelete: "cascade",
          // Ids are never rewritten, so there is nothing to follow on update -
          // and a table that started cascading updates would be a schema this
          // app did not ask for.
          onUpdate: "no action",
        });
      }
    },
  );

  /**
   * And the two dialects declare the same set, not merely each a correct one.
   * A key present on Postgres and absent on SQLite is a rule enforced on one
   * deployment and not the other, which is what this whole file is for.
   */
  test.each(CASCADING)(
    "%s declares identical keys on both dialects",
    (_name, _column, pgTable, sqliteTable) => {
      expect(shapeOf("sqlite", sqliteTable).foreignKeys).toEqual(
        shapeOf("pg", pgTable).foreignKeys,
      );
    },
  );
});
