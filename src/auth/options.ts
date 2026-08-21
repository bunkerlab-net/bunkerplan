import { apiKey } from "@better-auth/api-key";
import type { SecondaryStorage } from "@better-auth/core/db";
import { passkey } from "@better-auth/passkey";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
  EXPECTED_ACCOUNT_HEADER,
  WRONG_ACCOUNT_CODE,
} from "../http/expected-account.ts";
import { handleEmail, newUserHandle } from "../ids.ts";
import type { Logger } from "../log.ts";

/**
 * Marks the provisional identity returned by `resolveUser`. A signed-in user
 * adding a second passkey takes the session branch inside the plugin, so
 * `resolveUser` is never called and this prefix is absent - that is how
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
   * Better Auth's own output is routed here so it cannot bypass redaction.
   * Optional because the `auth generate` config stubs build these options
   * without ever running a server.
   */
  logger?: Logger | undefined;
  /**
   * Runs before Better Auth deletes anything, while the user's plan rows still
   * exist. Objects live outside the database, so no foreign key can clean them
   * up - this hook is the only chance. Throwing aborts the deletion.
   */
  onBeforeDeleteUser?: ((userId: string) => Promise<void>) | undefined;
}

/**
 * Passkey-only signup. Better Auth's `user` table requires a unique non-null
 * email and a non-null name, and the passkey plugin never creates users - so
 * we synthesise both and create the user ourselves inside the plugin's hooks.
 */
function passkeyPlugin(input: AuthOptionsInput) {
  const plugin = passkey({
    rpID: input.rpId,
    rpName: input.rpName,
    origin: input.baseURL,
    registration: {
      // Lets `generate-register-options` skip freshSessionMiddleware, so a
      // brand-new visitor can register with nothing but a passkey.
      requireSession: false,
      // Provisional identity only - no DB write. An abandoned WebAuthn
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
        const created = await ctx.context.internalAdapter.createUser(
          {
            name: handle,
            // RFC 2606 reserved TLD: a synthetic address that can never resolve
            // or be mailed.
            email: handleEmail(handle),
            emailVerified: false,
          },
          // The provisioning origin, required since 1.7. `ValidateUserInfoMethod`
          // keeps an open `string` arm for plugins; this deployment only ever
          // creates a user from an attested passkey.
          { method: "passkey" },
        );
        // Registration signs the user straight in. Without this the browser
        // would need a second WebAuthn ceremony immediately afterwards - two
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
  // Sign-in resolves a credential with a single lookup by this value, so two
  // rows sharing one id make it non-deterministic - and a passkey is the only
  // credential here, with no email recovery behind it. The plugin declares the
  // column indexed, not unique.
  //
  // Declaring it as a field attribute is what carries it into the generated
  // Drizzle schema, and so into every migration generated from it; it used to
  // be patched into that file by hand and lost on regeneration. The property
  // path is checked against the plugin's types, so an upstream rename fails to
  // compile instead of quietly dropping the constraint.
  Object.assign(plugin.schema.passkey.fields.credentialID, { unique: true });
  return plugin;
}

function apiKeyPlugin() {
  const plugin = apiKey({
    defaultPrefix: "bkp_",
    // Off because it is the wrong boundary, not because it is unconfigurable
    // - `timeWindow`/`maxRequests` would take our upload numbers happily. It
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
  // Same gap, same reason as above: the plugin omits this foreign key while
  // running at its `references: "user"` default, so the column always holds a
  // user id and its rows would otherwise outlive the account they name.
  Object.assign(plugin.schema.apikey.fields.referenceId, {
    references: { model: "user", field: "id", onDelete: "cascade" },
  });
  return plugin;
}

/**
 * Bridges Better Auth's own logging onto the app logger.
 *
 * It writes to `console` by default, which is the one output that bypasses the
 * redacting destination in src/log.ts - and an adapter error it reports can
 * carry a driver message with a connection string in it. Omitted entirely when
 * no logger is supplied, so the `auth generate` config stubs still build.
 */
function loggerOption(logger: Logger | undefined) {
  if (logger === undefined) return {};
  return {
    logger: {
      disabled: false,
      log: (
        level: "info" | "warn" | "error" | "debug",
        message: string,
        ...args: unknown[]
      ) => {
        logger[level]({ args, source: "better-auth" }, message);
      },
    },
  };
}

/**
 * Routes the router 404s outright, so there is nothing to probe.
 *
 * Two groups. Passkeys only, so every password and email-verification route
 * goes; and identity is immutable, so the routes that would rewrite it go too.
 *
 * `/update-user` is the load-bearing one. `user.name` IS the account handle:
 * it is minted at registration, shown in the nav, and what a plan grant is
 * addressed by. Grants resolve through the synthetic `@passkey.invalid`
 * address derived from the handle at signup, so a rename would leave the
 * owner looking at a handle whose grant they can no longer revoke - the
 * lookup would compute an address belonging to nobody. There is no profile to
 * edit in this product; the endpoint exists only because Better Auth ships
 * it.
 */
const DISABLED_PATHS = [
  "/sign-in/email",
  "/sign-up/email",
  "/forget-password",
  "/reset-password",
  "/change-password",
  "/change-email",
  "/verify-email",
  "/send-verification-email",
  "/update-user",
];

/**
 * KV is a cache; the database is the source of truth. `findSession` reads KV
 * first and falls back to the DB, so a KV miss or cross-region lag degrades to
 * a DB read instead of logging the user out.
 */
const SESSION = { storeSessionInDatabase: true };

/**
 * `enabled` is explicit because the default resolves it from NODE_ENV.
 *
 * Counters go to the database, not KV: Workers KV throttles one write per
 * second per key, takes up to 60s to propagate, and cannot increment atomically
 * for Better Auth's `consume`. The database path decides inside one conditional
 * UPDATE, so the count stays exact under concurrency. This is also what keeps
 * `SecondaryStorage.increment` out of reach - see src/kv/secondary-storage.ts.
 */
const RATE_LIMIT = {
  enabled: true,
  storage: "database",
  window: 60,
  max: 100,
} as const;

/**
 * Consume the WebAuthn challenge in the database rather than in KV.
 *
 * Better Auth 1.7 consumes a secondary-storage-only verification through
 * `SecondaryStorage.getAndDelete`. Valkey could serve that atomically with
 * `GETDEL`, but the shared `KvStore` seam exposes no such call and Workers KV
 * has no equivalent, so the adapter cannot offer it uniformly across both
 * drivers. The database path can: on pg and sqlite the adapter's `consumeOne`
 * is a single `DELETE ... RETURNING`, so exactly one caller carries the row
 * away and a challenge cannot be redeemed twice. Better Auth also takes a
 * lock around that, but it is an in-process promise map - it reduces
 * contention within one isolate and guarantees nothing across them, so the
 * single statement is what the claim rests on. Same reasoning as `SESSION`
 * above.
 */
const VERIFICATION = { storeInDatabase: true };

/**
 * Refuses an account deletion that does not name the account it authenticated
 * as, then runs the caller's cleanup.
 *
 * This is the only place the intended account can be confirmed safely. Better
 * Auth resolves the session and calls this inside one request, so `user` is
 * who the request authenticated as and the header is who the caller meant -
 * nothing can swap the session between them, the way it can between a client's
 * own check and the request that follows it. See src/http/expected-account.ts.
 *
 * Required, not merely honoured when present: a check a caller can skip is one
 * a client regression silently drops, and what it guards is the deletion of
 * the wrong account.
 *
 * The cleanup runs second because it needs the rows that are about to go.
 * Throwing from either half aborts the deletion.
 */
async function refuseUnlessExpected(
  user: { id: string },
  request: Request | undefined,
  cleanUp: ((userId: string) => Promise<void>) | undefined,
) {
  const expected = request?.headers.get(EXPECTED_ACCOUNT_HEADER);
  if (expected !== user.id) {
    throw new APIError("BAD_REQUEST", {
      code: WRONG_ACCOUNT_CODE,
      message:
        expected == null
          ? `deleting an account requires the ${EXPECTED_ACCOUNT_HEADER} header`
          : "this session is not the account you meant to delete",
    });
  }
  await cleanUp?.(user.id);
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
    ...loggerOption(input.logger),

    session: SESSION,
    rateLimit: RATE_LIMIT,
    disabledPaths: DISABLED_PATHS,
    verification: VERIFICATION,

    // Without this the default `x-forwarded-for` resolves nothing on Workers,
    // every caller shares one bucket per path, and `session.ipAddress` is null.
    // `database.joins` left `experimental` in 1.7; the relations it reads are
    // the generated ones, so regenerate both dialects with
    // `bun run auth:generate:pg` and `:sqlite` after touching it.
    advanced: {
      ipAddress: { ipAddressHeaders: [input.clientIpHeader] },
      database: { joins: true },
    },

    user: {
      deleteUser: {
        enabled: true,
        /*
         * `sendDeleteAccountVerification` is deliberately absent, and adding
         * it would open a path around `refuseUnlessExpected`. That flow deletes
         * on a link followed from an inbox, in a request that carries no
         * `x-expected-account` and cannot - so the hook would have nothing to
         * compare and would refuse every one of them, or would have to be
         * loosened to let them through. Addresses here are synthetic
         * (`…@passkey.invalid`) and receive no mail, so the flow buys nothing
         * either way.
         */
        beforeDelete: (user: { id: string }, request?: Request) =>
          refuseUnlessExpected(user, request, input.onBeforeDeleteUser),
      },
    },

    plugins: [passkeyPlugin(input), apiKeyPlugin()],
  } satisfies BetterAuthOptions;
}
