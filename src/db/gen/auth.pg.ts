/**
 * CLI-only config for `auth generate`. Never imported at runtime.
 *
 * Deliberately passes no `secondaryStorage` so the `session` table IS emitted —
 * that is what `session.storeSessionInDatabase: true` needs at runtime. The
 * `rateLimit` table comes from `rateLimit.storage: "database"` in
 * buildAuthOptions and is required.
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { buildAuthOptions } from "../../auth/options.ts";

export const auth = betterAuth(
  buildAuthOptions({
    database: drizzleAdapter({} as never, { provider: "pg" }),
    baseURL: "http://localhost",
    secret: "x".repeat(32),
    rpId: "localhost",
    rpName: "BunkerPlan",
    clientIpHeader: "x-forwarded-for",
  }),
);
