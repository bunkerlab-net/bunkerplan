import "./dom-env.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useState } from "hono/jsx";
import { DangerZone } from "../../src/client/DangerZone.tsx";
import {
  client,
  explode,
  navigations,
  ok,
  refuse,
  setSession,
  signedIn,
  useAuthStub,
} from "./auth-stub.ts";
import { click, flush, mount, type, useHarness } from "./harness.tsx";

// Arms the module stubs for this file; unarmed, the real modules answer.
useHarness();
useAuthStub();

const HANDLE = "swift-otter-42";
/** The account the panel is mounted for; `signedIn()` reports the same id. */
const USER_ID = "u1";

/**
 * The one control in the app that destroys data with no undo. Its whole
 * safety story is the typed confirmation, the disabled button, and the
 * identity the panel was mounted for, so all three are pinned here rather
 * than assumed.
 */
describe("DangerZone", () => {
  // The panel freezes the signed-in account at mount and refuses to delete
  // anything it cannot match against, so every test needs a session.
  beforeEach(() => {
    setSession(signedIn(HANDLE));
  });

  /** Cleanup for the one test that replaces `location.assign`. Idempotent. */
  let restoreAssign: (() => void) | null = null;
  afterEach(() => {
    restoreAssign?.();
    restoreAssign = null;
  });

  test("names the handle that has to be typed", () => {
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    expect(view.find("code").textContent).toBe(HANDLE);
    expect(view.text()).toContain("It cannot be undone.");
  });

  test("a panel mounted before the session resolves can still delete", async () => {
    /*
     * The account is latched on the first render that has one, not on the first
     * render. `useRef(userId)` alone would freeze the unresolved `null` and
     * leave this panel permanently unable to delete anything, because
     * `deleteAccount` refuses when there is no id to compare against.
     */
    client.deleteUser = ok({ success: true });

    function Resolving() {
      const [userId, setUserId] = useState<string | null>(null);
      return (
        <>
          <button id="resolve" type="button" onClick={() => setUserId(USER_ID)}>
            resolve
          </button>
          <DangerZone handle={HANDLE} userId={userId} />
        </>
      );
    }

    const view = mount(<Resolving />);
    await click(view.find("#resolve"));

    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.byText("button", "Delete account"));

    expect(navigations).toEqual(["/"]);
  });

  test("a press before the session resolves refuses, and the retry still works", async () => {
    /*
     * The refusal has to be the retryable kind. An unresolved id says nothing
     * about who is signed in, so reporting it as the wrong account would latch
     * the control closed and the panel would never delete anything, however
     * long the visitor waited.
     */
    let deletes = 0;
    client.deleteUser = async () => {
      deletes += 1;
      return { data: { success: true }, error: null };
    };

    function Resolving() {
      const [userId, setUserId] = useState<string | null>(null);
      return (
        <>
          <button id="resolve" type="button" onClick={() => setUserId(USER_ID)}>
            resolve
          </button>
          <DangerZone handle={HANDLE} userId={userId} />
        </>
      );
    }

    const view = mount(<Resolving />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.byText("button", "Delete account"));

    expect(deletes).toBe(0);
    expect(view.text()).not.toContain("different account");
    expect(view.text()).toContain("not finished loading");
    // Re-enabled, which is the whole point: a latched button here is a panel
    // that can never delete the account it was mounted for.
    expect(
      view.byText<HTMLButtonElement>("button", "Delete account").disabled,
    ).toBe(false);
    expect(navigations).toEqual([]);

    await click(view.find("#resolve"));
    await click(view.byText("button", "Delete account"));

    expect(deletes).toBe(1);
    expect(navigations).toEqual(["/"]);
  });

  test("a later userId prop cannot redefine which account is intended", async () => {
    /*
     * The seeding above must not become "last render wins". A prop that changed
     * to another account while this client still holds the first one would
     * otherwise retarget the delete, and `deleteAccount` compares against
     * whatever the ref holds.
     */
    client.deleteUser = ok({ success: true });

    function Swapping() {
      const [userId, setUserId] = useState<string | null>(USER_ID);
      return (
        <>
          <button id="swap" type="button" onClick={() => setUserId("u2")}>
            swap
          </button>
          <DangerZone handle={HANDLE} userId={userId} />
        </>
      );
    }

    const view = mount(<Swapping />);
    await click(view.find("#swap"));

    // The session is still the account this mounted for, so the delete goes
    // through - which is only true if the swap did not take.
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.byText("button", "Delete account"));

    expect(navigations).toEqual(["/"]);
  });

  test("the delete button is dead until the handle matches exactly", async () => {
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    const button = view.find<HTMLButtonElement>("button");
    expect(button.disabled).toBe(true);

    await type(view.find<HTMLInputElement>("#confirm-handle"), "swift-otter");
    expect(button.disabled).toBe(true);

    await type(
      view.find<HTMLInputElement>("#confirm-handle"),
      HANDLE.toUpperCase(),
    );
    expect(button.disabled).toBe(true);

    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    expect(button.disabled).toBe(false);
  });

  test("a confirmed delete leaves for the home page and stays held", async () => {
    client.deleteUser = ok({ success: true });
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    // `assign()` is asynchronous: the document is still here and still
    // interactive. Re-enabling now would offer a second delete of an account
    // that is already gone.
    expect(navigations).toEqual(["/"]);
    expect(view.find<HTMLButtonElement>("button").disabled).toBe(true);
  });

  test("a click dispatched without the typed handle deletes nothing", async () => {
    let attempts = 0;
    client.deleteUser = async () => {
      attempts += 1;
      return { data: { success: true }, error: null };
    };
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);

    // Nothing typed, so the button is disabled - but a dispatched `click`
    // still runs the listener, because only user activation is suppressed.
    // `disabled` is a hint to a person, not a guard on the call.
    const button = view.find<HTMLButtonElement>("button");
    expect(button.disabled).toBe(true);
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();

    expect(attempts).toBe(0);
    expect(navigations).toEqual([]);
  });

  test("a navigation that throws still never offers a second delete", async () => {
    let attempts = 0;
    client.deleteUser = async () => {
      attempts += 1;
      return { data: { success: true }, error: null };
    };
    // The descriptor, not the value: `location.assign` is installed by
    // tests/client/auth-stub.ts on the one `window.location` this process has,
    // and putting a plain writable property back where a differently configured
    // one stood would leave that stub subtly replaced. `afterEach` is the
    // fallback for a test abandoned at the timeout, which reaches no `finally`.
    const original = Object.getOwnPropertyDescriptor(window.location, "assign");
    restoreAssign = () => {
      if (original === undefined) {
        Reflect.deleteProperty(window.location, "assign");
      } else {
        Object.defineProperty(window.location, "assign", original);
      }
      // Cleared last: a restore that threw must stay on the fallback's list.
      restoreAssign = null;
    };
    Object.defineProperty(window.location, "assign", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("navigation blocked");
      },
    });

    try {
      const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
      await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
      await click(view.find("button"));

      /*
       * The redirect failed but the account is gone, so there is nothing left
       * to retry. Re-enabling would invite a ceremony against an account that
       * no longer exists, and reporting the navigation error would read as a
       * deletion that did not happen.
       */
      expect(view.find(".error").textContent).toBe(
        "Your account is deleted. Reload the page to continue.",
      );
      expect(view.find<HTMLButtonElement>("button").disabled).toBe(true);

      // And the control genuinely does not answer a second press.
      view
        .find("button")
        .dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      await flush();
      expect(attempts).toBe(1);
    } finally {
      restoreAssign?.();
    }
  });

  test("a refusal is shown and the visitor stays put", async () => {
    client.deleteUser = refuse("account has plans pending removal");
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    expect(view.find(".error").textContent).toBe(
      "account has plans pending removal",
    );
    expect(navigations).toEqual([]);
  });

  test("a stale session is re-authenticated and the delete retried once", async () => {
    let attempt = 0;
    client.deleteUser = async () => {
      attempt += 1;
      return attempt === 1
        ? { data: null, error: { message: "stale", code: "SESSION_EXPIRED" } }
        : { data: { success: true }, error: null };
    };
    // The same account the panel was mounted for: the retry is only allowed
    // when the ceremony came back holding the id being deleted, and spelling it
    // as a literal here would keep passing if `USER_ID` ever changed.
    client.signIn.passkey = ok({ user: { id: USER_ID } });

    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    expect(attempt).toBe(2);
    expect(navigations).toEqual(["/"]);
  });

  test("a ceremony that signs in another account deletes nothing", async () => {
    let attempt = 0;
    client.deleteUser = async () => {
      attempt += 1;
      return {
        data: null,
        error: { message: "stale", code: "SESSION_EXPIRED" },
      };
    };
    /*
     * `signIn.passkey()` names no account: the browser offers every passkey on
     * the device and the visitor picks. Picking another account's here must
     * not turn into a delete of that account - the handle in the box is still
     * this one's.
     */
    client.signIn.passkey = ok({ user: { id: "u2", name: "brisk-heron" } });

    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    // One call: the first, which is what reported the stale session.
    expect(attempt).toBe(1);
    expect(view.find(".error").textContent).toContain("different account");
    expect(navigations).toEqual([]);
  });

  test("after a wrong-account ceremony the control stays dead", async () => {
    let attempt = 0;
    client.deleteUser = async () => {
      attempt += 1;
      return {
        data: null,
        error: { message: "stale", code: "SESSION_EXPIRED" },
      };
    };
    client.signIn.passkey = ok({ user: { id: "u2", name: "brisk-heron" } });

    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));
    expect(attempt).toBe(1);

    /*
     * The ceremony really did change who this client is signed in as, and the
     * panel re-renders with that account's handle. Releasing the button here
     * would let the next press delete the account the visitor never named,
     * with a fresh session and nothing left to compare it against.
     */
    setSession(signedIn("brisk-heron", "u2"));
    await flush();
    expect(view.find<HTMLButtonElement>("button").disabled).toBe(true);

    view
      .find("button")
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    await flush();
    expect(attempt).toBe(1);
    expect(navigations).toEqual([]);
  });

  test("a client already holding another account is refused", async () => {
    let attempt = 0;
    client.deleteUser = async () => {
      attempt += 1;
      return { data: { success: true }, error: null };
    };
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);

    /*
     * The store now reports a different account than the one frozen at mount.
     * No claim here about a session changed elsewhere and not yet observed -
     * the client cannot see that, and two requests cannot be made atomic from
     * here. What is pinned is narrower and real: once the client does know it
     * is holding somebody else, this panel stops.
     */
    setSession(signedIn("brisk-heron", "u2"));
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    expect(attempt).toBe(0);
    expect(view.find(".error").textContent).toContain("different account");
    expect(navigations).toEqual([]);
  });

  test("a failed re-authentication stops before deleting anything", async () => {
    let attempt = 0;
    client.deleteUser = async () => {
      attempt += 1;
      return {
        data: null,
        error: { message: "stale", code: "SESSION_EXPIRED" },
      };
    };
    client.signIn.passkey = refuse("the ceremony was cancelled");

    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    expect(attempt).toBe(1);
    expect(view.find(".error").textContent).toBe("the ceremony was cancelled");
    expect(navigations).toEqual([]);
  });

  test("a whitespace-only refusal reads as the fallback, not a blank line", async () => {
    client.deleteUser = async () => ({
      data: null,
      error: { message: "   " },
    });
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    // `?? fallback` only catches an absent message; a blank one rendered an
    // error line with nothing in it, which reads as no error at all.
    expect(view.find(".error").textContent).toBe(
      "could not delete the account",
    );
  });

  test("a blank re-authentication refusal falls back the same way", async () => {
    client.deleteUser = async () => ({
      data: null,
      error: { message: "stale", code: "SESSION_EXPIRED" },
    });
    client.signIn.passkey = async () => ({
      data: null,
      error: { message: "" },
    });

    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    expect(view.find(".error").textContent).toBe("re-authentication failed");
  });

  test("the button is released again after a refusal, so it can be retried", async () => {
    client.deleteUser = refuse("try again");
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    expect(view.find<HTMLButtonElement>("button").disabled).toBe(false);
  });

  test("a retry clears the previous refusal rather than leaving it up", async () => {
    client.deleteUser = refuse("account has plans pending removal");
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));
    expect(view.find(".error").textContent).toBe(
      "account has plans pending removal",
    );

    // The second attempt succeeds. A message left over from the first would
    // report a failure that is not happening, on a page that is leaving.
    client.deleteUser = ok({ success: true });
    await click(view.find("button"));

    expect(view.maybe(".error")).toBeNull();
    expect(navigations).toEqual(["/"]);
  });

  test("two clicks in one tick delete once, not twice", async () => {
    let attempts = 0;
    client.deleteUser = async () => {
      attempts += 1;
      return { data: null, error: null };
    };
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);

    // Both dispatched before any re-render, which is the whole window: `busy`
    // is state, so the second handler would still read the value the first one
    // closed over. This is the one action in the app that cannot be undone.
    const button = view.find("button");
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();

    expect(attempts).toBe(1);
  });

  test("a returned refusal still allows a retry", async () => {
    let attempts = 0;
    client.deleteUser = async () => {
      attempts += 1;
      return { data: null, error: { message: "not fresh enough" } };
    };
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);

    // A refusal returns out of the `try` without reaching the `catch`, so a
    // latch released only there would ignore every attempt after the first
    // while the button sat enabled, inviting exactly this retry.
    await click(view.find("button"));
    await click(view.find("button"));

    expect(attempts).toBe(2);
  });

  test("a thrown failure is not swallowed into a stuck button", async () => {
    client.deleteUser = explode("network down");
    const view = mount(<DangerZone handle={HANDLE} userId={USER_ID} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    // Both halves matter: without the click the button is enabled merely
    // because the handle matched, which is what this used to assert.
    expect(view.find(".error").textContent).toBe("network down");
    expect(view.find<HTMLButtonElement>("button").disabled).toBe(false);
    expect(navigations).toEqual([]);
  });
});
