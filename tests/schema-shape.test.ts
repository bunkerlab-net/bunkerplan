import { describe, expect, test } from "bun:test";
import { getTableName, is, SQL, type Table } from "drizzle-orm";
import {
  PgDialect,
  getTableConfig as pgTableConfig,
} from "drizzle-orm/pg-core";
import {
  SQLiteSyncDialect,
  getTableConfig as sqliteTableConfig,
} from "drizzle-orm/sqlite-core";
import * as pgAccountClosing from "../src/db/schema/account-closing.pg.ts";
import * as sqliteAccountClosing from "../src/db/schema/account-closing.sqlite.ts";
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
    onDelete: string | undefined;
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
    const recorded = DIALECT_DIFFERENCES[`${table}.${column.name}`];
    if (recorded === undefined) return column;

    expect({ type: column.type, default: column.default }).toEqual(
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
          onDelete: key.onDelete,
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
