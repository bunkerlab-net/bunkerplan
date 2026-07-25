/**
 * CLI-only config for `auth generate`. Never imported at runtime.
 *
 * Deliberately passes no `secondaryStorage` so the `session` table IS emitted —
 * that is what `session.storeSessionInDatabase: true` needs at runtime. Do not
 * set `rateLimit.storage: "database"` here or a stray `rateLimit` table appears.
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { buildAuthOptions } from "../../auth/options.ts";

export const auth = betterAuth(
  buildAuthOptions({
    database: drizzleAdapter({} as never, { provider: "sqlite" }),
    baseURL: "http://localhost",
    secret: "x".repeat(32),
    rpId: "localhost",
    rpName: "BunkerPlan",
  }),
);
