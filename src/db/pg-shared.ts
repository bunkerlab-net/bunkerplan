import * as authSchema from "./schema/auth.pg.ts";
import * as planSchema from "./schema/plan.pg.ts";

export const pgSchema = { ...authSchema, ...planSchema };

export type PgSchema = typeof pgSchema;
