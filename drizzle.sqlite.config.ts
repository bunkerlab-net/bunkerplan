import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: [
    "./src/db/schema/account-closing.sqlite.ts",
    "./src/db/schema/auth.sqlite.ts",
    "./src/db/schema/plan.sqlite.ts",
    "./src/db/schema/rate-limit.sqlite.ts",
  ],
  out: "./drizzle/sqlite",
  dbCredentials: { url: process.env["SQLITE_PATH"] ?? "./data/bunkerplan.db" },
});
