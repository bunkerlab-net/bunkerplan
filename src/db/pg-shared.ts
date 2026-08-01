import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as accountClosingSchema from "./schema/account-closing.pg.ts";
import * as authSchema from "./schema/auth.pg.ts";
import * as planSchema from "./schema/plan.pg.ts";
import * as rateLimitSchema from "./schema/rate-limit.pg.ts";

export const pgSchema = {
  ...authSchema,
  ...planSchema,
  ...rateLimitSchema,
  ...accountClosingSchema,
};

export type PgSchema = typeof pgSchema;

export type PgDb = NodePgDatabase<PgSchema>;
