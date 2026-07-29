import { describe, expect, test } from "bun:test";
import { buildAuthOptions } from "../src/auth/options.ts";
import type { Logger } from "../src/log.ts";

/**
 * The Better Auth wiring, as a value.
 *
 * `betterAuth()` itself needs a database, so what is checked here is the
 * options object handed to it - which is where every decision in this app's
 * auth actually lives. Three of them are load-bearing beyond configuration:
 * registration must create no user until an authenticator has attested, the
 * identity-mutating routes must 404 rather than exist, and Better Auth's own
 * logging must not reach `console`, which is the one output that bypasses the
 * redacting destination in src/log.ts.
 *
 * The two schema constraints are covered by auth-schema-constraints.test.ts.
 */

const BASE = {
  database: undefined,
  baseURL: "https://plans.example.test",
  secret: "x".repeat(32),
  rpId: "plans.example.test",
  rpName: "BunkerPlan",
  clientIpHeader: "cf-connecting-ip",
};

const options = buildAuthOptions(BASE);

describe("the options as a whole", () => {
  test("names the deployment it was built for", () => {
    expect(options.appName).toBe("BunkerPlan");
    expect(options.baseURL).toBe(BASE.baseURL);
    expect(options.secret).toBe(BASE.secret);
  });

  test("keeps sessions in the database, with KV only as a cache", () => {
    // A KV miss or cross-region lag then degrades to a database read rather
    // than logging the user out.
    expect(options.session.storeSessionInDatabase).toBe(true);
  });

  test("identifies callers by the header this deployment trusts", () => {
    // Without it the default resolves nothing on Workers, every caller shares
    // one bucket per path, and `session.ipAddress` is null.
    expect(options.advanced.ipAddress.ipAddressHeaders).toEqual([
      "cf-connecting-ip",
    ]);
  });

  test("counts rate limits in the database rather than KV", () => {
    // Workers KV throttles one write per second per key, takes up to 60s to
    // propagate, and exposes no increment for Better Auth's atomic consume.
    expect(options.rateLimit).toEqual({
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
    });
  });

  test("enables account deletion", () => {
    expect(options.user.deleteUser.enabled).toBe(true);
  });

  test("carries exactly the two plugins, in order", () => {
    expect(options.plugins.map((plugin) => plugin.id)).toEqual([
      "passkey",
      "api-key",
    ]);
  });
});

describe("the routes that are switched off", () => {
  test.each([
    "/sign-in/email",
    "/sign-up/email",
    "/forget-password",
    "/reset-password",
    "/change-password",
    "/change-email",
    "/verify-email",
    "/send-verification-email",
  ])("%s 404s, because this app is passkeys only", (path) => {
    expect(options.disabledPaths).toContain(path);
  });

  test("/update-user 404s, because the handle is the identity", () => {
    // `user.name` is minted at registration, shown in the nav, and what a plan
    // grant is addressed by. A rename would leave the owner looking at a
    // handle whose grant they can no longer revoke.
    expect(options.disabledPaths).toContain("/update-user");
  });
});

describe("secondary storage", () => {
  test("is omitted entirely when none is supplied", () => {
    // Present-but-undefined is not the same thing: Better Auth branches on the
    // key existing.
    expect("secondaryStorage" in options).toBe(false);
  });

  test("is passed through when one is", () => {
    const kv = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    };
    const withKv = buildAuthOptions({ ...BASE, secondaryStorage: kv });

    expect(withKv.secondaryStorage).toBe(kv);
  });
});

describe("logging", () => {
  test("is omitted when no logger is supplied, so the generator stubs build", () => {
    expect("logger" in options).toBe(false);
  });

  test.each(["info", "warn", "error", "debug"] as const)(
    "a %s line is routed onto the app logger, not console",
    (level) => {
      const lines: Array<{ level: string; message: string; meta: unknown }> =
        [];
      const record =
        (name: string) =>
        (meta: unknown, message: string): void => {
          lines.push({ level: name, message, meta });
        };
      const logger = {
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
        debug: record("debug"),
      } as unknown as Logger;

      const withLogger = buildAuthOptions({ ...BASE, logger });
      withLogger.logger?.log(level, "adapter failed", { detail: 1 }, "extra");

      // `console` is the one output that bypasses the redacting destination in
      // src/log.ts, and an adapter error can carry a connection string.
      expect(lines).toEqual([
        {
          level,
          message: "adapter failed",
          meta: { args: [{ detail: 1 }, "extra"], source: "better-auth" },
        },
      ]);
    },
  );

  test("the bridge is enabled, not merely present", () => {
    const withLogger = buildAuthOptions({
      ...BASE,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      } as unknown as Logger,
    });

    expect(withLogger.logger?.disabled).toBe(false);
  });
});

describe("deleting an account", () => {
  test("no hook is registered when none is supplied", () => {
    expect("beforeDelete" in options.user.deleteUser).toBe(false);
  });

  test("the hook runs with the id, before Better Auth deletes anything", async () => {
    const swept: string[] = [];
    const withHook = buildAuthOptions({
      ...BASE,
      onBeforeDeleteUser: async (userId) => {
        swept.push(userId);
      },
    });

    await withHook.user.deleteUser.beforeDelete?.({ id: "user-a" });

    // Objects live outside the database, so no foreign key can clean them up.
    expect(swept).toEqual(["user-a"]);
  });

  test("a throwing hook aborts the deletion", async () => {
    const withHook = buildAuthOptions({
      ...BASE,
      onBeforeDeleteUser: async () => {
        throw new Error("storage is unreachable");
      },
    });

    expect(
      withHook.user.deleteUser.beforeDelete?.({ id: "user-a" }),
    ).rejects.toThrow("storage is unreachable");
  });
});
