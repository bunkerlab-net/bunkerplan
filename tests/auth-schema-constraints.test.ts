import { describe, expect, test } from "bun:test";
import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";
import { getTableName } from "drizzle-orm";
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
