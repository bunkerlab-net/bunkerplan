import { describe, expect, test } from "bun:test";
import { buildAuthOptions } from "../src/auth/options.ts";
import {
  EXPECTED_ACCOUNT_HEADER,
  WRONG_ACCOUNT_CODE,
} from "../src/http/expected-account.ts";
import type { Logger } from "../src/log.ts";
import { BASE } from "./auth-fixture.ts";

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
  /**
   * Runs `body` with every console method captured, and hands back what they
   * were called with.
   *
   * The claim below is that a Better Auth line reaches the app logger *instead
   * of* console, and only half of that is visible in the app logger's own
   * capture: a bridge that wrote to both would satisfy it.
   *
   * The swap spans one synchronous `body()` and is undone in a `finally`, so
   * nothing else in the process can run inside the window - which is what
   * keeps a shared global safe to borrow here.
   */
  const consoleCallsDuring = (body: () => void): unknown[][] => {
    const names = ["log", "info", "warn", "error", "debug"] as const;
    const originals = names.map((name) => [name, console[name]] as const);
    const calls: unknown[][] = [];
    for (const name of names) {
      console[name] = (...args: unknown[]) => {
        calls.push([name, ...args]);
      };
    }
    try {
      body();
    } finally {
      for (const [name, original] of originals) console[name] = original;
    }
    return calls;
  };

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
      const shouted = consoleCallsDuring(() => {
        withLogger.logger?.log(level, "adapter failed", { detail: 1 }, "extra");
      });

      // `console` is the one output that bypasses the redacting destination in
      // src/log.ts, and an adapter error can carry a connection string.
      expect(shouted).toEqual([]);
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
  const asking = (expected: string | null) =>
    new Request("https://plans.example.test/api/auth/delete-user", {
      method: "POST",
      ...(expected === null
        ? {}
        : { headers: { [EXPECTED_ACCOUNT_HEADER]: expected } }),
    });

  test("the hook is always registered, because it is what guards the delete", () => {
    expect(typeof options.user.deleteUser.beforeDelete).toBe("function");
  });

  test("no verification callback, so no delete arrives without the header", () => {
    // `sendDeleteAccountVerification` would delete on a link followed from an
    // inbox - a request that carries no `x-expected-account` and cannot. See
    // the note in src/auth/options.ts.
    expect("sendDeleteAccountVerification" in options.user.deleteUser).toBe(
      false,
    );
  });

  test("the hook runs with the id, before Better Auth deletes anything", async () => {
    const swept: string[] = [];
    const withHook = buildAuthOptions({
      ...BASE,
      onBeforeDeleteUser: async (userId) => {
        swept.push(userId);
      },
    });

    await withHook.user.deleteUser.beforeDelete?.(
      { id: "user-a" },
      asking("user-a"),
    );

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

    await expect(
      withHook.user.deleteUser.beforeDelete?.(
        { id: "user-a" },
        asking("user-a"),
      ),
    ).rejects.toThrow("storage is unreachable");
  });

  test("a session that is not the named account is refused", async () => {
    /*
     * The whole point of the header. The session belongs to `user-b` - a
     * sign-in in another tab landed between the client's own check and this
     * request - and `user-a` is the account the reader typed a handle for.
     */
    const swept: string[] = [];
    const withHook = buildAuthOptions({
      ...BASE,
      onBeforeDeleteUser: async (userId) => {
        swept.push(userId);
      },
    });

    // The code and the status, not only the wording: docs/self-hosting.md
    // promises callers a `400` carrying `WRONG_ACCOUNT`, and the client reads
    // that code to decide the refusal is terminal. A rename or a status change
    // here would silently turn a blocked delete back into a retryable one.
    await expect(
      withHook.user.deleteUser.beforeDelete?.(
        { id: "user-b" },
        asking("user-a"),
      ),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { code: "WRONG_ACCOUNT" },
    });
    // Refused before the sweep, so nothing of `user-b`'s was touched either.
    expect(swept).toEqual([]);
  });

  test("a request that names no account is refused rather than assumed", async () => {
    // Failing closed: a caller that skipped the header has not said which
    // account it means, and defaulting to the session is the guess this
    // exists to prevent. The same code as a mismatch, because the client does
    // the same thing with either - stops.
    await expect(
      options.user.deleteUser.beforeDelete?.({ id: "user-a" }, asking(null)),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { code: WRONG_ACCOUNT_CODE },
    });
  });

  test("a call with no request at all is refused too", async () => {
    // `beforeDelete` takes the request as optional. Nothing in Better Auth's
    // delete route omits it, but a check that reads a header cannot pass
    // something it never saw.
    await expect(
      options.user.deleteUser.beforeDelete?.({ id: "user-a" }),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { code: WRONG_ACCOUNT_CODE },
    });
  });
});
