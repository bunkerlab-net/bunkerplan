import "./dom-env.ts";
import { describe, expect, test } from "bun:test";
import { DangerZone } from "../../src/client/DangerZone.tsx";
import {
  client,
  explode,
  navigations,
  ok,
  refuse,
  useAuthStub,
} from "./auth-stub.ts";
import { click, flush, mount, type, useHarness } from "./harness.tsx";

// Arms the module stubs for this file; unarmed, the real modules answer.
useHarness();
useAuthStub();

const HANDLE = "swift-otter-42";

/**
 * The one control in the app that destroys data with no undo. Its whole
 * safety story is the typed confirmation and the disabled button, so both are
 * pinned here rather than assumed.
 */
describe("DangerZone", () => {
  test("names the handle that has to be typed", () => {
    const view = mount(<DangerZone handle={HANDLE} />);
    expect(view.find("code").textContent).toBe(HANDLE);
    expect(view.text()).toContain("It cannot be undone.");
  });

  test("the delete button is dead until the handle matches exactly", async () => {
    const view = mount(<DangerZone handle={HANDLE} />);
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

  test("a confirmed delete leaves for the home page", async () => {
    client.deleteUser = ok({ success: true });
    const view = mount(<DangerZone handle={HANDLE} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    expect(navigations).toEqual(["/"]);
  });

  test("the button stays held while the page is leaving", async () => {
    client.deleteUser = ok({ success: true });
    const view = mount(<DangerZone handle={HANDLE} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    // `assign()` is asynchronous: the document is still here and still
    // interactive. Re-enabling now would offer a second delete of an account
    // that is already gone.
    expect(navigations).toEqual(["/"]);
    expect(view.find<HTMLButtonElement>("button").disabled).toBe(true);
  });

  test("a navigation that throws releases the button instead of wedging it", async () => {
    client.deleteUser = ok({ success: true });
    const assign = window.location.assign;
    Object.defineProperty(window.location, "assign", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("navigation blocked");
      },
    });

    try {
      const view = mount(<DangerZone handle={HANDLE} />);
      await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
      await click(view.find("button"));

      // The page is not leaving after all, so the hold has to come off: the
      // visitor is still sitting in front of a control that must answer.
      expect(view.find(".error").textContent).toBe("navigation blocked");
      expect(view.find<HTMLButtonElement>("button").disabled).toBe(false);
    } finally {
      Object.defineProperty(window.location, "assign", {
        configurable: true,
        writable: true,
        value: assign,
      });
    }
  });

  test("a refusal is shown and the visitor stays put", async () => {
    client.deleteUser = refuse("account has plans pending removal");
    const view = mount(<DangerZone handle={HANDLE} />);
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
    client.signIn.passkey = ok({ user: { id: "u1" } });

    const view = mount(<DangerZone handle={HANDLE} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    expect(attempt).toBe(2);
    expect(navigations).toEqual(["/"]);
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

    const view = mount(<DangerZone handle={HANDLE} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    expect(attempt).toBe(1);
    expect(view.find(".error").textContent).toBe("the ceremony was cancelled");
    expect(navigations).toEqual([]);
  });

  test("the button is released again after a refusal, so it can be retried", async () => {
    client.deleteUser = refuse("try again");
    const view = mount(<DangerZone handle={HANDLE} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    expect(view.find<HTMLButtonElement>("button").disabled).toBe(false);
  });

  test("two clicks in one tick delete once, not twice", async () => {
    let attempts = 0;
    client.deleteUser = async () => {
      attempts += 1;
      return { data: null, error: null };
    };
    const view = mount(<DangerZone handle={HANDLE} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);

    // Both dispatched before any re-render, which is the whole window: `busy`
    // is state, so the second handler would still read the value the first one
    // closed over. This is the one action in the app that cannot be undone.
    const button = view.find("button");
    button.dispatchEvent(new Event("click", { bubbles: true }));
    button.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(attempts).toBe(1);
  });

  test("a returned refusal still allows a retry", async () => {
    let attempts = 0;
    client.deleteUser = async () => {
      attempts += 1;
      return { data: null, error: { message: "not fresh enough" } };
    };
    const view = mount(<DangerZone handle={HANDLE} />);
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
    const view = mount(<DangerZone handle={HANDLE} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);
    await click(view.find("button"));

    // Both halves matter: without the click the button is enabled merely
    // because the handle matched, which is what this used to assert.
    expect(view.find(".error").textContent).toBe("network down");
    expect(view.find<HTMLButtonElement>("button").disabled).toBe(false);
    expect(navigations).toEqual([]);
  });
});
