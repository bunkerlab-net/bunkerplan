import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/db/schema/auth.sqlite.ts", "./src/db/schema/plan.sqlite.ts"],
  out: "./drizzle/sqlite",
  dbCredentials: { url: process.env["SQLITE_PATH"] ?? "./data/bunkerplan.db" },
});
