import "./dom-env.ts";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
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
 * vanilla client does not ship: its first render is unconditionally pending,
 * which is what the server produced, and the store is read once effects run
 * and tracked from then on.
 */

type Subscriber = (state: SessionValue) => void;

interface SessionValue {
  data: { user: { name: string } } | null;
  error: { message: string } | null;
  isPending: boolean;
}

/** No answer yet - `isPending`, which is not the same as signed out. */
const UNRESOLVED: SessionValue = { data: null, error: null, isPending: true };

let value: SessionValue = UNRESOLVED;
const subscribers = new Set<Subscriber>();
let unsubscribed = 0;
/** How many listeners `push` has delivered to, so a late one is observable. */
let delivered = 0;
/** Every `baseURL` a client was constructed with, so laziness is observable. */
const constructedWith: string[] = [];
/** One entry per construction, so a second one cannot append to the first. */
const pluginNames: string[][] = [];

function push(next: SessionValue): void {
  value = next;
  for (const notify of subscribers) {
    delivered += 1;
    notify(next);
  }
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
    pluginNames.push(options.plugins.map((plugin) => plugin.id));
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

/*
 * The check sits in `beforeEach`, not `afterEach`: Bun runs `afterEach` hooks
 * in reverse registration order, so this one would run before the harness's
 * teardown and read a tree that is still mounted. Here the previous test's
 * teardown has finished.
 *
 * And there is no `subscribers.clear()`. The harness unmounts through hono's
 * own root, which runs each subtree's effect cleanups, so a subscription still
 * in the set is one that leaked - and clearing would tidy it away before the
 * next test could see it.
 */
beforeEach(() => {
  expect(subscribers.size).toBe(0);
  value = UNRESOLVED;
});

afterAll(() => {
  // The last test has no `beforeEach` after it to check its own cleanup.
  expect(subscribers.size).toBe(0);
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

  /*
   * Both of these read what the construction was handed, so both need a
   * construction to have been recorded. Asserted rather than guarded with an
   * `if`: the project runs `bun test --isolate`, which gives every file its own
   * module registry, so the singleton is always built inside this file. Skipping
   * the assertion when the recording is empty would turn a genuine regression -
   * a client built with the wrong origin, or with a plugin dropped - into a
   * silent pass.
   */
  test("is bound to the window's own origin, which WebAuthn requires", () => {
    authClient();

    expect(constructedWith.length).toBeGreaterThan(0);
    // The newest construction is the one holding the live singleton; index 0
    // would name whichever call happened to be first in the process.
    expect(constructedWith.at(-1)).toBe(window.location.origin);
  });

  test("carries the passkey and API key plugins", () => {
    authClient();

    expect(constructedWith.length).toBeGreaterThan(0);
    // The newest construction's own list, not every id ever recorded: a flat
    // array would read as ["passkey", "api-key", "passkey", ...] the moment
    // anything constructed a second client.
    expect(pluginNames.at(-1)).toEqual(["passkey", "api-key"]);
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
  test("reads the store once effects run, not at first render", async () => {
    value = {
      data: { user: { name: "swift-otter" } },
      error: null,
      isPending: false,
    };
    const view = mount(<Probe />);
    await flush();
    // Not a synchronous seed: the first paint is pending (below), and the
    // stored session arrives when the effect reads it. Both orderings matter -
    // the first keeps hydration matching the server, the second is what puts
    // the visitor's name on screen without a second round trip.

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

  test("an update between mount and the first effect is not lost", async () => {
    const view = mount(<Probe />);

    /*
     * The window the effect has to close. Nothing is subscribed yet, so this
     * notification reaches no one; only the `get()` the effect performs before
     * subscribing can recover it. A subscribe-only effect would leave the
     * component pending forever against a store that had already answered.
     */
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
    /*
     * A store update after the teardown must reach nobody. The span being gone
     * says nothing - it left with the unmount, whatever the store did - and
     * re-reading the empty set only repeats the line above. What is watched is
     * the delivery itself: a leaked subscription is one this push would still
     * call.
     */
    const beforeDelivery = delivered;
    push({ data: { user: { name: "late" } }, error: null, isPending: false });
    await flush();

    expect(delivered).toBe(beforeDelivery);
  });
});
