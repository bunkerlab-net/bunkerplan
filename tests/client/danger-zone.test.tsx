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
import { click, mount, type, useHarness } from "./harness.tsx";

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

  test("a thrown failure is not swallowed into a stuck button", async () => {
    client.deleteUser = explode("network down");
    const view = mount(<DangerZone handle={HANDLE} />);
    await type(view.find<HTMLInputElement>("#confirm-handle"), HANDLE);

    expect(view.find<HTMLButtonElement>("button").disabled).toBe(false);
  });
});
