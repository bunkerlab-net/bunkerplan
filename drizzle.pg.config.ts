import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema/auth.pg.ts", "./src/db/schema/plan.pg.ts"],
  out: "./drizzle/pg",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
});
