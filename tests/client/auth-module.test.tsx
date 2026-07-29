import "./dom-env.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import * as realApiKey from "@better-auth/api-key/client";
import * as realPasskey from "@better-auth/passkey/client";
import * as realClient from "better-auth/client";
import { useState } from "hono/jsx";
import { type Arm, armWhileFileRuns } from "../armed-mock.ts";

/**
 * src/client/auth.ts itself, rather than the stub the panels get.
 *
 * Two things here are load-bearing and neither is visible from a panel test.
 * The client is a lazy singleton because constructing it reads
 * `window.location.origin`, which does not exist during the server render -
 * and WebAuthn rejects a ceremony whose origin does not match. And
 * `useSession` is five lines standing in for the React hook Better Auth's
 * vanilla client does not ship: it must seed from the store synchronously so
 * the first client render matches the server's, then track it.
 */

type Subscriber = (state: SessionValue) => void;

interface SessionValue {
  data: { user: { name: string } } | null;
  error: { message: string } | null;
  isPending: boolean;
}

const SIGNED_OUT: SessionValue = { data: null, error: null, isPending: true };

let value: SessionValue = SIGNED_OUT;
const subscribers = new Set<Subscriber>();
let unsubscribed = 0;
/** Every `baseURL` a client was constructed with, so laziness is observable. */
const constructedWith: string[] = [];
const pluginNames: string[] = [];

function push(next: SessionValue): void {
  value = next;
  for (const notify of subscribers) notify(next);
}

const arm: Arm = { on: false };
const passthrough = {
  client: { ...realClient },
  passkey: { ...realPasskey },
  apiKey: { ...realApiKey },
};

mock.module("better-auth/client", () => ({
  ...passthrough.client,
  createAuthClient: (options: {
    baseURL: string;
    plugins: ReadonlyArray<{ id: string }>;
  }) => {
    if (!arm.on) return passthrough.client.createAuthClient(options as never);
    constructedWith.push(options.baseURL);
    pluginNames.push(...options.plugins.map((plugin) => plugin.id));
    return {
      useSession: {
        get: () => value,
        subscribe: (notify: Subscriber) => {
          subscribers.add(notify);
          return () => {
            unsubscribed += 1;
            subscribers.delete(notify);
          };
        },
      },
    };
  },
}));

mock.module("@better-auth/passkey/client", () => ({
  ...passthrough.passkey,
  passkeyClient: () =>
    arm.on ? { id: "passkey" } : passthrough.passkey.passkeyClient(),
}));
mock.module("@better-auth/api-key/client", () => ({
  ...passthrough.apiKey,
  apiKeyClient: () =>
    arm.on ? { id: "api-key" } : passthrough.apiKey.apiKeyClient(),
}));

/*
 * Dynamic on purpose, and the one place in this repo that needs to be: a
 * static import is hoisted above the `mock.module` calls, so the real
 * `better-auth/client` would be evaluated and the singleton below would close
 * over it. Importing after registration is what puts the stub in place.
 */
const { authClient, useSession } = await import("../../src/client/auth.ts");
const { click, flush, mount, useHarness } = await import("./harness.tsx");

// Unmounts anything this file mounts. Registered before the arm below, so a
// tree comes down while the stubbed packages are still standing in.
useHarness();

// Arms the stubs above for this file; unarmed, the real packages answer.
armWhileFileRuns(arm, () => {});

afterEach(() => {
  value = SIGNED_OUT;
  subscribers.clear();
});

describe("authClient", () => {
  test("is constructed once and reused", () => {
    const first = authClient();
    const afterFirst = constructedWith.length;
    const second = authClient();

    expect(second).toBe(first);
    /*
     * That the second call added nothing, rather than that the total is one.
     * The singleton is module-level and lives for the process, so anything
     * importing this file's dependencies could already have built it before the
     * recording arm went on, which would make an absolute count of 1 wrong
     * through no fault of the code. "A repeat call constructs nothing" is the
     * invariant, and it holds whatever ran first.
     */
    expect(constructedWith.length).toBe(afterFirst);
  });

  test("is bound to the window's own origin, which WebAuthn requires", () => {
    authClient();
    // The most recent construction is the one that produced the live singleton;
    // index 0 would name whichever call happened to be first in the process.
    expect(constructedWith.at(-1)).toBe(window.location.origin);
  });

  test("carries the passkey and API key plugins", () => {
    authClient();
    expect(pluginNames).toEqual(["passkey", "api-key"]);
  });
});

function Probe() {
  const state = useSession();
  return (
    <span>
      {state.isPending ? "pending" : (state.data?.user.name ?? "anonymous")}
      {state.error === null ? "" : `:${state.error.message}`}
    </span>
  );
}

/** Drops `Probe` out of the tree, which is how the effect teardown is driven. */
function Toggle() {
  const [shown, setShown] = useState(true);
  return (
    <div>
      {shown ? <Probe /> : "gone"}
      <button type="button" onClick={() => setShown(false)}>
        hide
      </button>
    </div>
  );
}

describe("useSession", () => {
  test("seeds from the store, so hydration starts where the server left off", async () => {
    value = {
      data: { user: { name: "swift-otter" } },
      error: null,
      isPending: false,
    };
    const view = mount(<Probe />);
    await flush();

    expect(view.text()).toBe("swift-otter");
  });

  test("the very first render is pending, matching the signed-out server markup", () => {
    value = {
      data: { user: { name: "swift-otter" } },
      error: null,
      isPending: false,
    };
    const view = mount(<Probe />);

    // Before effects run. The server cannot know the session, so the client's
    // first paint must not claim one either.
    expect(view.text()).toBe("pending");
  });

  test("tracks a later sign-in", async () => {
    const view = mount(<Probe />);
    await flush();
    expect(view.text()).toBe("pending");

    push({
      data: { user: { name: "brisk-heron" } },
      error: null,
      isPending: false,
    });
    await flush();

    expect(view.text()).toBe("brisk-heron");
  });

  test("surfaces a store error", async () => {
    const view = mount(<Probe />);
    await flush();

    push({
      data: null,
      error: { message: "session lookup failed" },
      isPending: false,
    });
    await flush();

    expect(view.text()).toBe("anonymous:session lookup failed");
  });

  test("unsubscribes when the subscriber leaves the tree", async () => {
    const before = unsubscribed;
    const view = mount(<Toggle />);
    await flush();
    expect(subscribers.size).toBe(1);

    await click(view.find("button"));

    expect(unsubscribed).toBe(before + 1);
    expect(subscribers.size).toBe(0);
    // A store update after the teardown must reach nobody: writing into an
    // unmounted tree is how a leaked subscription shows up.
    push({ data: { user: { name: "late" } }, error: null, isPending: false });
    await flush();
    expect(view.maybe("span")).toBeNull();
  });
});
