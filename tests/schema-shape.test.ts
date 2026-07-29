import { describe, expect, test } from "bun:test";
import { getTableName, type Table } from "drizzle-orm";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
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
  columns: Array<{ name: string; notNull: boolean; primary: boolean }>;
  primaryKey: string[];
  indexes: string[][];
  foreignKeys: Array<{
    columns: string[];
    references: string[];
    onDelete: string | undefined;
  }>;
  checks: string[];
}

/** One comparable description per table, from either dialect's config. */
function shapeOf(dialect: "pg" | "sqlite", table: Table): Shape {
  const config =
    dialect === "pg"
      ? pgTableConfig(table as never)
      : sqliteTableConfig(table as never);

  const composite = config.primaryKeys.flatMap((key) =>
    key.columns.map((column) => column.name),
  );
  const inline = config.columns
    .filter((column) => column.primary)
    .map((column) => column.name);

  return {
    name: getTableName(table),
    columns: config.columns
      .map((column) => ({
        name: column.name,
        notNull: column.notNull,
        primary: column.primary,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    primaryKey: [...composite, ...inline].sort(),
    indexes: config.indexes
      .map((index) =>
        (index.config.columns as Array<{ name?: string }>).map(
          (column) => column.name ?? "?",
        ),
      )
      .sort(),
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
      .sort((a, b) => a.columns.join().localeCompare(b.columns.join())),
    checks: config.checks.map((check) => check.name).sort(),
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
  const shapes = [
    ["pg", shapeOf("pg", pg)],
    ["sqlite", shapeOf("sqlite", sqlite)],
  ] as const;

  test("is named the same in both dialects", () => {
    expect(shapes.map(([, shape]) => shape.name)).toEqual([name, name]);
  });

  test("the two dialects have not drifted", () => {
    const [[, fromPg], [, fromSqlite]] = shapes;
    expect(fromSqlite.columns.map((column) => column.name)).toEqual(
      fromPg.columns.map((column) => column.name),
    );
    expect(fromSqlite.primaryKey).toEqual(fromPg.primaryKey);
    expect(fromSqlite.foreignKeys).toEqual(fromPg.foreignKeys);
    expect(fromSqlite.indexes).toEqual(fromPg.indexes);
    expect(fromSqlite.checks).toEqual(fromPg.checks);
  });

  test.each(shapes)(
    "%s marks every column that cannot be null",
    (_d, shape) => {
      const nullable = shape.columns
        .filter((column) => !column.notNull && !column.primary)
        .map((column) => column.name);

      // `label` and `share_code_hash` are the only optional values in the
      // application tables; everything else is required at write time.
      expect(nullable).toEqual(
        name === "plan" ? ["label", "share_code_hash"] : [],
      );
    },
  );
});

describe("cascading from the account", () => {
  const cascading = [
    ["plan", pgPlan.plan, sqlitePlan.plan, "user_id"],
    ["plan_grant", pgPlan.planGrant, sqlitePlan.planGrant, "user_id"],
    [
      "upload_rate_limit",
      pgRateLimit.uploadRateLimit,
      sqliteRateLimit.uploadRateLimit,
      "key",
    ],
    [
      "account_closing",
      pgAccountClosing.accountClosing,
      sqliteAccountClosing.accountClosing,
      "user_id",
    ],
  ] as const;

  test.each(cascading)(
    "%s.%s goes with the user",
    (_name, pg, sqlite, column) => {
      for (const [dialect, table] of [
        ["pg", pg],
        ["sqlite", sqlite],
      ] as const) {
        // Nothing prunes these tables, so without the cascade a deleted account
        // leaves its rows behind for good.
        expect(shapeOf(dialect, table).foreignKeys).toContainEqual({
          columns: [column],
          references: ["user.id"],
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
      expect(shape.indexes).toEqual([["window_start"]]);
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
      expect(shapeOf(dialect, table).checks).toEqual(["plan_visibility_check"]);
    },
  );

  test.each([
    ["pg", pgPlan.plan],
    ["sqlite", sqlitePlan.plan],
  ] as const)(
    "%s indexes the owner, which is how the dashboard lists",
    (dialect, table) => {
      expect(shapeOf(dialect, table).indexes).toContainEqual(["user_id"]);
    },
  );

  test.each([
    ["pg", pgPlan.planGrant],
    ["sqlite", sqlitePlan.planGrant],
  ] as const)(
    "%s keys a grant by the pair, so it cannot be duplicated",
    (dialect, table) => {
      expect(shapeOf(dialect, table).primaryKey).toEqual([
        "plan_id",
        "user_id",
      ]);
      // And indexes the grantee, which is how the read gate checks one.
      expect(shapeOf(dialect, table).indexes).toContainEqual(["user_id"]);
    },
  );
});
