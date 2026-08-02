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
 *
 * Declaration order, deliberately not sorted. Sorting would make the text
 * independent of how the tuple happens to be written, which sounds free and is
 * not: `["public", "private"]` sorts to `('private', 'public')`, a different
 * string, and `bun run db:generate` answers with two migrations - a
 * `DROP CONSTRAINT`/`ADD CONSTRAINT` pair on Postgres and an eighteen-line
 * rebuild of `plan` on SQLite, the table every user's rows live in. That is a
 * real rebuild of real data to reorder two literals inside an `IN` list which
 * means precisely the same thing either way.
 *
 * The drift sorting would guard against is already loud: reordering the tuple
 * changes this string, `db:generate` writes a migration, and CI fails on a
 * `drizzle/` that command would rewrite. A reviewer sees it as a diff rather
 * than as nothing at all, which is the better of the two failures.
 */
export const PLAN_VISIBILITY_CHECK = `"visibility" in (${PLAN_VISIBILITIES.map(
  (value) => `'${value}'`,
).join(", ")})`;
