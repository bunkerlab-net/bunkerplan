import { describe, expect, test } from "bun:test";
import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";
import { createTableRelationsHelpers, getTableName } from "drizzle-orm";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import { buildAuthOptions } from "../src/auth/options.ts";
import * as pgSchema from "../src/db/schema/auth.pg.ts";
import * as sqliteSchema from "../src/db/schema/auth.sqlite.ts";

/**
 * Two constraints the api-key and passkey plugins leave off their own schemas,
 * declared back on in src/auth/options.ts.
 *
 * They used to be patched into the generated Drizzle files by hand, and
 * regeneration dropped them silently: the schema files are what drizzle-kit
 * diffs against, so the next `bun db:generate` emitted a migration reverting
 * both. Nothing failed. Asserted at both levels for that reason - the
 * declaration is the mechanism, the generated tables are the artefact, and a
 * removed declaration would otherwise stay invisible until someone regenerated.
 *
 * Written against Drizzle's Relations v1, which is what `drizzle-orm@^0.45.2`
 * resolves to. `createTableRelationsHelpers` and the `declared.config` /
 * `declared.table` reads below are v1 internals; a v2 adapter reshapes both and
 * these assertions have to be rewritten rather than merely repointed.
 */

const [passkeyPlugin, apiKeyPlugin] = buildAuthOptions({
  database: undefined,
  baseURL: "http://localhost",
  secret: "x".repeat(32),
  rpId: "localhost",
  rpName: "BunkerPlan",
  clientIpHeader: "x-forwarded-for",
}).plugins;

/**
 * The interface `auth generate` reads. Naming the wider type is what makes
 * these attributes visible: the plugins' own schema types are literals that
 * omit the very ones under test. An assignment, not a cast - it still fails if
 * the shapes diverge.
 */
const passkeyFields: BetterAuthPluginDBSchema = passkeyPlugin.schema;
const apiKeyFields: BetterAuthPluginDBSchema = apiKeyPlugin.schema;

describe("the plugin schemas the generator reads", () => {
  test("apikey.referenceId names the user that owns the key", () => {
    expect(apiKeyFields["apikey"]?.fields["referenceId"]).toMatchObject({
      references: { model: "user", field: "id", onDelete: "cascade" },
    });
  });

  test("passkey.credentialID is unique", () => {
    expect(passkeyFields["passkey"]?.fields["credentialID"]).toMatchObject({
      unique: true,
    });
  });
});

const dialects = [
  ["pg", pgTableConfig(pgSchema.apikey), pgTableConfig(pgSchema.passkey)],
  [
    "sqlite",
    sqliteTableConfig(sqliteSchema.apikey),
    sqliteTableConfig(sqliteSchema.passkey),
  ],
] as const;

describe.each(dialects)(
  "the generated %s schema drizzle-kit diffs",
  (_dialect, apikey, passkey) => {
    test("cascades apikey rows from the account they name", () => {
      expect(
        apikey.foreignKeys.map((key) => {
          const reference = key.reference();
          return {
            columns: reference.columns.map((column) => column.name),
            references: reference.foreignColumns.map(
              (column) => `${getTableName(column.table)}.${column.name}`,
            ),
            onDelete: key.onDelete,
          };
        }),
      ).toContainEqual({
        columns: ["reference_id"],
        references: ["user.id"],
        onDelete: "cascade",
      });
    });

    test("refuses a second row holding the same credential id", () => {
      const credentialId = passkey.columns.find(
        (column) => column.name === "credential_id",
      );
      expect(credentialId?.isUnique).toBe(true);
    });
  },
);

/**
 * Every generated table that names an account, and the cascade that removes
 * its rows with one.
 *
 * Better Auth writes these files, so they are not reviewed line by line on
 * regeneration - and account deletion is the operation that depends on them:
 * `deleteUser` removes the `user` row and lets the database take the rest. A
 * cascade the generator dropped would leave sessions, credentials, and keys
 * belonging to an account that no longer exists, all still verifiable.
 */
const OWNED_BY_USER: ReadonlyArray<[table: string, column: string]> = [
  ["session", "user_id"],
  ["account", "user_id"],
  ["passkey", "user_id"],
  ["apikey", "reference_id"],
];

type Dialect = "pg" | "sqlite";

const generated = [["pg"], ["sqlite"]] as const satisfies ReadonlyArray<
  [Dialect]
>;

/**
 * The foreign keys drizzle-kit would emit for one table.
 *
 * The dialect is resolved here rather than threaded through `describe.each`:
 * the two `getTableConfig` functions take different table types, so a tuple
 * carrying both has no common signature to call.
 *
 * `shapeOf` in tests/schema-shape.test.ts projects references the same way and
 * is deliberately not shared with this. That one sorts, because it compares two
 * whole shapes for equality and needs a stable order; every caller here reads
 * the result with `toContainEqual` or against `[]`, where order cannot change
 * an outcome. Merging them would mean one helper carrying a sort that only half
 * its callers want, to save nine lines in a test.
 */
function foreignKeysOf(dialect: Dialect, name: string) {
  const schema = dialect === "pg" ? pgSchema : sqliteSchema;
  const table = schema[name as "session"];
  if (table === undefined) {
    // A table renamed by `auth generate` would otherwise reach the dialect
    // config as `undefined` and fail somewhere inside Drizzle, naming nothing.
    throw new Error(`no ${dialect} auth table named "${name}"`);
  }
  const config =
    dialect === "pg"
      ? pgTableConfig(table as never)
      : sqliteTableConfig(table as never);
  return config.foreignKeys.map((key) => {
    const reference = key.reference();
    return {
      columns: reference.columns.map((column) => column.name),
      references: reference.foreignColumns.map(
        (target) => `${getTableName(target.table)}.${target.name}`,
      ),
      onDelete: key.onDelete,
    };
  });
}

describe.each(generated)("every %s auth table", (dialect) => {
  const keysOf = (name: string) => foreignKeysOf(dialect, name);

  test.each(OWNED_BY_USER)(
    "%s.%s cascades from the account",
    (table, column) => {
      expect(keysOf(table)).toContainEqual({
        columns: [column],
        references: ["user.id"],
        onDelete: "cascade",
      });
    },
  );

  test("user and verification hang from nothing", () => {
    // The root of the graph, and a table of short-lived tokens that names no
    // account at all.
    expect(keysOf("user")).toEqual([]);
    expect(keysOf("verification")).toEqual([]);
  });

  test("rate_limit is Better Auth's own and stays unattached", () => {
    // Deliberately not the upload counter - see src/db/schema/rate-limit.*.ts.
    // It is keyed by path and address, so there is no account to cascade from.
    expect(keysOf("rateLimit")).toEqual([]);
  });

  test("a session is found by its token, which is what every request does", () => {
    const schema = dialect === "pg" ? pgSchema : sqliteSchema;
    const columns =
      dialect === "pg"
        ? pgTableConfig(schema.session as never).columns
        : sqliteTableConfig(schema.session as never).columns;

    expect(columns.find((column) => column.name === "token")?.isUnique).toBe(
      true,
    );
  });
});

/**
 * The relational graph, which is not decoration here.
 *
 * `buildAuthOptions` turns on `experimental.joins`, so Better Auth issues
 * relational queries rather than separate lookups - and drizzle resolves those
 * through exactly these declarations. A `fields`/`references` pair pointing at
 * the wrong column is a join that silently returns the wrong rows, which no
 * foreign key catches.
 */
describe.each(generated)("the %s relational graph", (dialect) => {
  const schema = dialect === "pg" ? pgSchema : sqliteSchema;

  /**
   * Invokes a `relations()` declaration the way drizzle does.
   *
   * `declared.config` and `declared.table` are Relations v1 internals. Drizzle
   * exposes no public way to read a declaration back, and the alternative -
   * not testing the graph - leaves `experimental.joins` resolving against
   * whatever the generator last emitted. The exposure is bounded rather than
   * removed: `drizzle-orm` is `^0.45.2`, which for a `0.x` version admits
   * patches only, so a v2 adapter cannot arrive without a deliberate bump.
   */
  const configOf = (name: string): Record<string, unknown> => {
    const declared = schema[name as "sessionRelations"];
    if (declared === undefined) {
      throw new Error(`no ${dialect} relations declared as "${name}"`);
    }
    return declared.config(
      createTableRelationsHelpers(declared.table),
    ) as Record<string, unknown>;
  };

  test("a user has many of each thing it owns", () => {
    expect(Object.keys(configOf("userRelations")).sort()).toEqual([
      "accounts",
      "apikeys",
      "passkeys",
      "sessions",
    ]);
  });

  test.each([
    ["sessionRelations", "user_id"],
    ["accountRelations", "user_id"],
    ["passkeyRelations", "user_id"],
    ["apikeyRelations", "reference_id"],
  ])("%s joins on %s", (name, column) => {
    const relation = configOf(name)["user"] as
      | {
          config: {
            fields: Array<{ name: string }>;
            references: Array<{ name: string }>;
          };
        }
      | undefined;

    // Asserted first: a renamed or removed declaration otherwise throws a bare
    // TypeError on the next line, which does not say which one went missing.
    expect(relation, `${name} declares no "user" relation`).toBeDefined();

    expect(relation?.config.fields.map((field) => field.name)).toEqual([
      column,
    ]);
    expect(relation?.config.references.map((field) => field.name)).toEqual([
      "id",
    ]);
  });
});
