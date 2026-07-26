import { apiKey } from "@better-auth/api-key";
import type { SecondaryStorage } from "@better-auth/core/db";
import { passkey } from "@better-auth/passkey";
import type { BetterAuthOptions } from "better-auth";
import { setSessionCookie } from "better-auth/cookies";
import { newUserHandle } from "../ids.ts";

/**
 * Marks the provisional identity returned by `resolveUser`. A signed-in user
 * adding a second passkey takes the session branch inside the plugin, so
 * `resolveUser` is never called and this prefix is absent — that is how
 * `afterVerification` distinguishes "new signup" from "add a passkey".
 */
const PENDING = "pending:";

export interface AuthOptionsInput {
  database: BetterAuthOptions["database"];
  secondaryStorage?: SecondaryStorage | undefined;
  baseURL: string;
  secret: string;
  rpId: string;
  rpName: string;
  /**
   * Header the runtime can be trusted to have set to the real client IP.
   * Without it Better Auth resolves no IP, and every caller shares one
   * rate-limit bucket per path.
   */
  clientIpHeader: string;
  /**
   * Runs before Better Auth deletes anything, while the user's plan rows still
   * exist. Objects live outside the database, so no foreign key can clean them
   * up — this hook is the only chance. Throwing aborts the deletion.
   */
  onBeforeDeleteUser?: ((userId: string) => Promise<void>) | undefined;
}

/**
 * Passkey-only signup. Better Auth's `user` table requires a unique non-null
 * email and a non-null name, and the passkey plugin never creates users — so
 * we synthesise both and create the user ourselves inside the plugin's hooks.
 */
function passkeyPlugin(input: AuthOptionsInput) {
  return passkey({
    rpID: input.rpId,
    rpName: input.rpName,
    origin: input.baseURL,
    registration: {
      // Lets `generate-register-options` skip freshSessionMiddleware, so a
      // brand-new visitor can register with nothing but a passkey.
      requireSession: false,
      // Provisional identity only — no DB write. An abandoned WebAuthn
      // ceremony must not leave an orphan user row behind.
      resolveUser: async () => {
        const handle = newUserHandle();
        return { id: `${PENDING}${handle}`, name: handle };
      },
      // Runs only after the authenticator has actually attested. Create the
      // real user here; the returned id overrides the passkey's owner.
      afterVerification: async ({ ctx, user }) => {
        if (!user.id.startsWith(PENDING)) return;
        const handle = user.name;
        const created = await ctx.context.internalAdapter.createUser({
          name: handle,
          // RFC 2606 reserved TLD: a synthetic address that can never resolve
          // or be mailed.
          email: `${handle}@passkey.invalid`,
          emailVerified: false,
        });
        // Registration signs the user straight in. Without this the browser
        // would need a second WebAuthn ceremony immediately afterwards — two
        // biometric prompts to sign up.
        const session = await ctx.context.internalAdapter.createSession(
          created.id,
          false,
        );
        await setSessionCookie(ctx, { session, user: created });
        return { userId: created.id };
      },
    },
  });
}

function apiKeyPlugin() {
  return apiKey({
    defaultPrefix: "bkp_",
    // Off because it is the wrong boundary, not because it is unconfigurable
    // — `timeWindow`/`maxRequests` would take our upload numbers happily. It
    // counts per KEY and only runs inside `verifyApiKey`, so it would let a
    // user lift their own ceiling by creating more keys and would not see the
    // dashboard's session uploads at all. `src/db/rate-limits.*.ts` counts per
    // USER across both credential types, which is the policy we actually want.
    // (Its own default, 10 per key per day, would also break uploads.)
    rateLimit: { enabled: false },
    // `defaultExpiresIn: null` gives the required optional expiry: omit
    // `expiresIn` on create and the key never expires. min/max are in DAYS
    // while the `expiresIn` sent on create is in SECONDS.
    keyExpiration: {
      defaultExpiresIn: null,
      minExpiresIn: 1,
      maxExpiresIn: 3650,
    },
    // Left at its `false` default: src/http/require-user.ts calls verifyApiKey
    // explicitly, so there is exactly one code path per credential type.
  });
}

/**
 * Deliberately un-annotated: `betterAuth()` infers its plugin API surface (e.g.
 * `auth.api.verifyApiKey`) from the literal `plugins` tuple. Annotating this as
 * `BetterAuthOptions` would widen it away. `satisfies` keeps the check.
 */
export function buildAuthOptions(input: AuthOptionsInput) {
  return {
    appName: "BunkerPlan",
    baseURL: input.baseURL,
    secret: input.secret,
    database: input.database,
    ...(input.secondaryStorage
      ? { secondaryStorage: input.secondaryStorage }
      : {}),

    // KV is a cache; the database is the source of truth. `findSession` reads
    // KV first and falls back to the DB, so a KV miss or cross-region lag
    // degrades to a DB read instead of logging the user out.
    session: { storeSessionInDatabase: true },

    // Without this the default `x-forwarded-for` resolves nothing on Workers,
    // every caller shares one bucket per path, and `session.ipAddress` is null.
    advanced: { ipAddress: { ipAddressHeaders: [input.clientIpHeader] } },

    // `enabled` is explicit because the default resolves it from NODE_ENV.
    // Counters go to the database, not KV: Workers KV throttles one write per
    // second per key, takes up to 60s to propagate, and exposes no `increment`
    // for Better Auth's atomic `consume`. The database path decides inside one
    // conditional UPDATE, so the count stays exact under concurrency.
    rateLimit: { enabled: true, storage: "database", window: 60, max: 100 },

    // Passkeys only. `emailAndPassword` already defaults to disabled; this
    // makes the router 404 the routes outright so there is nothing to probe.
    disabledPaths: [
      "/sign-in/email",
      "/sign-up/email",
      "/forget-password",
      "/reset-password",
      "/change-password",
      "/change-email",
      "/verify-email",
      "/send-verification-email",
    ],

    experimental: { joins: true },

    user: {
      deleteUser: {
        enabled: true,
        ...(input.onBeforeDeleteUser
          ? {
              beforeDelete: async (user: { id: string }) => {
                await input.onBeforeDeleteUser?.(user.id);
              },
            }
          : {}),
      },
    },

    plugins: [passkeyPlugin(input), apiKeyPlugin()],
  } satisfies BetterAuthOptions;
}
