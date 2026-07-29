import { describe, expect, mock, test } from "bun:test";
import * as cookieModule from "better-auth/cookies";
import { handleEmail } from "../src/ids.ts";
import { type Arm, armWhileFileRuns } from "./armed-mock.ts";

/**
 * The two hooks that carry passkey signup.
 *
 * Registration is the one flow with no session behind it, and the pair below
 * is the whole of it: a provisional identity that touches no table, and the
 * row created only once an authenticator has actually attested. Getting the
 * order wrong leaves an orphan user row behind every abandoned WebAuthn
 * ceremony.
 *
 * `setSessionCookie` is stubbed rather than driven. It is Better Auth's own
 * cookie serialiser and needs a fully built request context; what this file is
 * about is whether the hook hands it the session it just created, not how that
 * cookie is encoded.
 */

const cookies: Array<{ session: unknown; user: unknown }> = [];

/**
 * Only `setSessionCookie` is swapped; the rest of the module is handed back
 * untouched. Replacing the whole namespace would strip exports other parts of
 * Better Auth import - `expireCookie` among them - and break sign-out at load
 * time rather than in anything under test.
 */
const realCookies = { ...cookieModule };

const arm: Arm = { on: false };

mock.module("better-auth/cookies", () => ({
  ...realCookies,
  setSessionCookie: async (
    ctx: never,
    payload: { session: unknown; user: unknown },
  ) => {
    // Unarmed means another file is running and this registration outlived
    // ours; the real serialiser has to answer for it.
    if (!arm.on)
      return await realCookies.setSessionCookie(ctx, payload as never);
    cookies.push(payload);
  },
}));

// Arms the stub above for this file; unarmed, the real module answers.
armWhileFileRuns(arm, () => {
  cookies.length = 0;
});

/*
 * Dynamic on purpose: a static import is hoisted above the `mock.module` call,
 * so the real serialiser would be the one the hook closed over.
 */
const { buildAuthOptions } = await import("../src/auth/options.ts");

const BASE = {
  database: undefined,
  baseURL: "https://plans.example.test",
  secret: "x".repeat(32),
  rpId: "plans.example.test",
  rpName: "BunkerPlan",
  clientIpHeader: "cf-connecting-ip",
};

interface Registration {
  rpID: string;
  rpName: string;
  origin: string;
  registration: {
    requireSession: boolean;
    resolveUser: () => Promise<{ id: string; name: string }>;
    afterVerification: (input: {
      ctx: unknown;
      user: { id: string; name: string };
    }) => Promise<{ userId: string } | undefined>;
  };
}

function passkeyOptions(): Registration {
  // By `id`, not by position: `buildAuthOptions` fixes the order and
  // auth-options.test.ts pins it, but a lookup that assumed index 0 would read
  // the API key plugin's options and compare them against passkey fields, which
  // fails as a mismatch rather than as the wiring mistake it is.
  const plugin = buildAuthOptions(BASE).plugins.find(
    (candidate) => candidate.id === "passkey",
  );
  if (plugin === undefined) {
    throw new Error("buildAuthOptions registered no passkey plugin");
  }
  return plugin.options as unknown as Registration;
}

describe("passkey registration", () => {
  test("is bound to the relying party this deployment is", () => {
    const plugin = passkeyOptions();

    expect(plugin.rpID).toBe("plans.example.test");
    expect(plugin.rpName).toBe("BunkerPlan");
    // WebAuthn rejects a ceremony whose origin does not match.
    expect(plugin.origin).toBe(BASE.baseURL);
  });

  test("needs no session, so a brand-new visitor can register", () => {
    expect(passkeyOptions().registration.requireSession).toBe(false);
  });

  test("resolving a user writes nothing and mints a fresh handle each time", async () => {
    const { resolveUser } = passkeyOptions().registration;

    const first = await resolveUser();
    const second = await resolveUser();

    // An abandoned ceremony must not leave an orphan user row behind, so this
    // is a provisional identity rather than a row.
    expect(first.id).toStartWith("pending:");
    expect(first.id).toBe(`pending:${first.name}`);
    expect(second.name).not.toBe(first.name);
  });

  test("attestation creates the real user and signs them straight in", async () => {
    cookies.length = 0;
    const { resolveUser, afterVerification } = passkeyOptions().registration;
    const provisional = await resolveUser();
    const created: unknown[] = [];
    const sessions: string[] = [];
    const ctx = {
      context: {
        internalAdapter: {
          createUser: async (row: { name: string; email: string }) => {
            created.push(row);
            return { id: "user-real", ...row };
          },
          createSession: async (userId: string) => {
            sessions.push(userId);
            return { id: "session-1", userId };
          },
        },
      },
    };

    const result = await afterVerification({ ctx, user: provisional });

    expect(created).toEqual([
      {
        name: provisional.name,
        // RFC 2606 reserved TLD: an address that can never resolve or be
        // mailed.
        email: handleEmail(provisional.name),
        emailVerified: false,
      },
    ]);
    expect(sessions).toEqual(["user-real"]);
    // Without the cookie, signing up would need a second biometric prompt
    // immediately afterwards.
    expect(cookies).toEqual([
      {
        session: { id: "session-1", userId: "user-real" },
        user: {
          id: "user-real",
          name: provisional.name,
          email: handleEmail(provisional.name),
          emailVerified: false,
        },
      },
    ]);
    // The returned id overrides the passkey's provisional owner.
    expect(result).toEqual({ userId: "user-real" });
  });

  test("a signed-in user adding a second passkey creates no new account", async () => {
    cookies.length = 0;
    const { afterVerification } = passkeyOptions().registration;
    let touched = 0;
    const ctx = {
      context: {
        internalAdapter: {
          createUser: async () => {
            touched += 1;
            return { id: "nope" };
          },
          createSession: async () => {
            touched += 1;
            return { id: "nope" };
          },
        },
      },
    };

    // No `pending:` prefix: the plugin took its session branch, so
    // `resolveUser` was never called.
    const result = await afterVerification({
      ctx,
      user: { id: "user-real", name: "brisk-heron" },
    });

    expect(result).toBeUndefined();
    expect(touched).toBe(0);
    expect(cookies).toEqual([]);
  });
});
