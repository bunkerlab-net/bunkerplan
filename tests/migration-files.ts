import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `fileURLToPath` rather than `.pathname`: a URL pathname stays
// percent-encoded, so a checkout under a directory with a space in its name
// would resolve to a path that does not exist.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface MigrationFile {
  /** The leading number, which is what `seedBefore` in the data tests names. */
  n: number;
  /** The file as written, before any rewrite. */
  sql: string;
  statements: string[];
}

/**
 * The migrations of one dialect, in file order, split into statements.
 *
 * Four suites read the same directories, and each used to carry its own copy
 * of this loop; a change to how drizzle delimits statements would have had to
 * be found in all four. `rewrite` is for the Postgres suites, which redirect
 * every statement into a scratch schema before it runs.
 */
export function migrationFiles(
  dialect: "pg" | "sqlite",
  rewrite?: (sql: string) => string,
): MigrationFile[] {
  const dir = `${ROOT}drizzle/${dialect}`;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(`${dir}/${name}`, "utf8");
      return {
        n: Number(name.slice(0, 4)),
        sql,
        statements: (rewrite === undefined ? sql : rewrite(sql))
          .split("--> statement-breakpoint")
          .map((statement) => statement.trim())
          .filter((statement) => statement !== ""),
      };
    });
}
