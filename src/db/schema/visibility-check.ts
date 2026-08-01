import { PLAN_VISIBILITIES } from "../../limits.ts";

/**
 * The database CHECK expression for `plan.visibility`, spelled once.
 *
 * Both dialect schemas emit this into their migrations and the two texts have
 * to match: a value legal on Postgres and refused on SQLite is a plan that
 * stores on one deployment and fails on another. Assembled here rather than in
 * each schema file, so the quoting and the order cannot drift - and derived
 * from `PLAN_VISIBILITIES`, so the column can never permit a value the parsers
 * reject or refuse one they accept.
 *
 * Not in src/limits.ts, which is the leaf for wire-visible contract values; a
 * SQL fragment is neither wire-visible nor contract.
 *
 * Unqualified `"visibility"`, because SQLite has no `ADD CONSTRAINT` and
 * rebuilds the table instead, re-parsing a qualified reference after the
 * rename - see the note in src/db/schema/plan.sqlite.ts.
 *
 * Changing `PLAN_VISIBILITIES` changes this string, which is a migration:
 * run `bun run db:generate` and commit both dialects' output. CI fails on a
 * `drizzle/` that command would rewrite.
 */
export const PLAN_VISIBILITY_CHECK = `"visibility" in (${PLAN_VISIBILITIES.map(
  (value) => `'${value}'`,
).join(", ")})`;
