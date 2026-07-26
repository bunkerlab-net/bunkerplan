import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/db/schema/account-closing.pg.ts",
    "./src/db/schema/auth.pg.ts",
    "./src/db/schema/plan.pg.ts",
    "./src/db/schema/rate-limit.pg.ts",
  ],
  out: "./drizzle/pg",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
});
