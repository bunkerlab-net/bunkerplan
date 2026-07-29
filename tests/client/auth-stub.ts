import "./dom-env.ts";
import { mock } from "bun:test";
import * as real from "../../src/client/auth.ts";
import { type Arm, armWhileFileRuns } from "../armed-mock.ts";

/**
 * The Better Auth client, replaced.
 *
 * Every panel reaches the network through the `authClient()` singleton in
 * src/client/auth.ts, which builds a real client bound to `window.location`.
 * Standing that up in a test would mean a live server and a WebAuthn
 * authenticator, so the module is swapped instead and the suites assert on
 * what the panels do with each answer - including the refusals and throws a
 * real ceremony produces and a happy-path server never would.
 *
 * src/client/auth.ts itself is covered directly by auth-module.test.ts, which
 * stubs `better-auth/client` one level down rather than using this.
 */

type Answer = unknown;
type Fn = (...args: never[]) => Answer;

/** What `useSession()` reports, swapped per test. */
export interface SessionState {
  data: { user: { id: string; name: string } } | null;
  error: { message: string } | null;
  isPending: boolean;
}

export const SIGNED_OUT: SessionState = {
  data: null,
  error: null,
  isPending: false,
};

export function signedIn(handle = "swift-otter-42"): SessionState {
  return {
    data: { user: { id: "u1", name: handle } },
    error: null,
    isPending: false,
  };
}

export const PENDING: SessionState = {
  data: null,
  error: null,
  isPending: true,
};

/**
 * A refusal shaped the way Better Auth returns one: resolved, not thrown,
 * with the fault in `error`.
 */
export const refuse = (message: string, code?: string) => async () => ({
  data: null,
  error: code === undefined ? { message } : { message, code },
});

/** A fault the client throws rather than returns - a dropped network call. */
export const explode = (message: string) => async () => {
  throw new Error(message);
};

export const ok =
  <T>(data: T) =>
  async () => ({ data, error: null });

interface Client {
  apiKey: { list: Fn; create: Fn; delete: Fn };
  passkey: { listUserPasskeys: Fn; addPasskey: Fn; deletePasskey: Fn };
  signIn: { passkey: Fn };
  signOut: Fn;
  deleteUser: Fn;
}

const unset = (name: string) => () => {
  throw new Error(`${name} was called but this test did not stub it`);
};

function blank(): Client {
  return {
    apiKey: {
      list: unset("apiKey.list"),
      create: unset("apiKey.create"),
      delete: unset("apiKey.delete"),
    },
    passkey: {
      listUserPasskeys: unset("passkey.listUserPasskeys"),
      addPasskey: unset("passkey.addPasskey"),
      deletePasskey: unset("passkey.deletePasskey"),
    },
    signIn: { passkey: unset("signIn.passkey") },
    signOut: unset("signOut"),
    deleteUser: unset("deleteUser"),
  };
}

/** Mutated in place, so the stubbed module keeps pointing at it. */
export const client: Client = blank();

let session: SessionState = SIGNED_OUT;

export function setSession(next: SessionState): void {
  session = next;
}

export const authClientCalls: string[] = [];

const arm: Arm = { on: false };

/**
 * Captured before the registration below, and deliberately a copy: the live
 * namespace object is what `mock.module` replaces, so reading through it
 * afterwards would route the fallback straight back into this stub.
 */
const passthrough = { ...real };

/**
 * Every value export this stub stands in for.
 *
 * The list catches a name that has gone; `Unmocked` catches one that has
 * arrived, which a list cannot see and which would otherwise leave the export
 * missing from `stubs` and `undefined` for every armed consumer.
 */
const EXPORT_KEYS = [
  "authClient",
  "useSession",
] as const satisfies ReadonlyArray<keyof typeof real>;

type Unmocked = Exclude<keyof typeof real, (typeof EXPORT_KEYS)[number]>;

const implementations = {
  // Unarmed means some other file imported this stub earlier and the
  // registration outlived it. `auth-module.test.tsx` and `auth-ssr.test.ts`
  // exercise the real module and must get it.
  authClient: () => {
    if (!arm.on) return passthrough.authClient();
    authClientCalls.push("authClient");
    return client;
  },
  useSession: () => (arm.on ? session : passthrough.useSession()),
} satisfies Record<(typeof EXPORT_KEYS)[number], unknown> &
  Record<Unmocked, never>;

/** Built by mapping the list, so it is what the module carries, not just a check. */
const stubs = Object.fromEntries(
  EXPORT_KEYS.map((name) => [name, implementations[name]]),
);

mock.module("../../src/client/auth.ts", () => stubs);

/**
 * Where the page was sent, instead of going there.
 *
 * happy-dom treats an assign or a replace as a real navigation, which tears
 * down the document the assertions are about. Capturing them is also the only
 * way to check the targets, and `samePathOnly` exists precisely because one of
 * those is attacker-influenced.
 *
 * Gated on the arm like everything else here: `window.location` is one object
 * for the whole process, so an unarmed file has to get the navigation it
 * actually asked for rather than one this module quietly swallowed.
 */
export const navigations: string[] = [];

/** `replace` rather than `assign`: the gate drops `?code=` from history. */
export const replacements: string[] = [];

for (const [method, log] of [
  ["assign", navigations],
  ["replace", replacements],
] as const) {
  // Not `real`: that name is the `src/client/auth.ts` namespace imported above,
  // and shadowing it here makes this block read as if it reached into it.
  const navigate = window.location[method].bind(window.location);
  Object.defineProperty(window.location, method, {
    configurable: true,
    writable: true,
    value: (url: string) => {
      if (!arm.on) {
        navigate(url);
        return;
      }
      log.push(String(url));
    },
  });
}

/** Arms the stub for the calling suite. Without it, the real module answers. */
export function useAuthStub(): void {
  armWhileFileRuns(arm, () => {
    Object.assign(client, blank());
    session = SIGNED_OUT;
    navigations.length = 0;
    replacements.length = 0;
    authClientCalls.length = 0;
  });
}
