import "./dom-env.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { PasskeysPanel } from "../../src/client/PasskeysPanel.tsx";
import { client, explode, ok, refuse, useAuthStub } from "./auth-stub.ts";
import type { Mounted } from "./harness.tsx";
import {
  click,
  deferred,
  flush,
  mount,
  mountAsync,
  useHarness,
} from "./harness.tsx";

// Arms the module stubs for this file; unarmed, the real modules answer.
useHarness();
useAuthStub();

/**
 * Passkeys are the only way into an account here, which makes two of this
 * panel's states worth pinning rather than eyeballing: it must never say
 * "No passkeys" to an account that has one - not even for the length of the
 * first request - and it must not offer a Delete button for the last one,
 * because pressing it would lock the account out permanently.
 */

/**
 * The row shape the fixture supplies, so a misspelled override is a type error.
 *
 * Stricter than the panel's own optional fields on purpose: every row here sets
 * both, and the placeholder cases pass `null` explicitly rather than by omission.
 */
interface PasskeyRow {
  id: string;
  name: string | null;
  createdAt: Date | null;
}

const passkey = (over: Partial<PasskeyRow> = {}): PasskeyRow => ({
  id: "pk1",
  name: "Laptop",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

/**
 * The Delete control on one row.
 *
 * Asserted rather than cast: `as Element` on a missing index hands `click` an
 * `undefined` and the failure surfaces from inside the harness, naming nothing.
 */
const rowButton = (view: Mounted, index: number): Element => {
  const button = view.all("tbody button")[index];
  if (button === undefined) {
    throw new Error(`no button on row ${index} in:\n${view.text()}`);
  }
  return button;
};

beforeEach(() => {
  client.passkey.listUserPasskeys = ok([]);
});

describe("PasskeysPanel listing", () => {
  test("claims nothing while the first list is in flight", async () => {
    const pending = deferred<unknown[]>();
    client.passkey.listUserPasskeys = async () => ({
      data: await pending.answer(),
      error: null,
    });

    const view = mount(<PasskeysPanel />);
    await flush();
    expect(view.find(".empty").textContent).toBe("Loading…");

    pending.release([passkey()]);
    await flush();
    expect(view.maybe(".empty")).toBeNull();
    expect(view.all("tbody tr").length).toBe(1);
  });

  test("an account with no passkeys is told so once the list has answered", async () => {
    const view = await mountAsync(<PasskeysPanel />);

    expect(view.find(".empty").textContent).toBe("No passkeys.");
  });

  test("renders a row per passkey", async () => {
    client.passkey.listUserPasskeys = ok([
      passkey(),
      passkey({ id: "pk2", name: "Phone" }),
    ]);
    const view = await mountAsync(<PasskeysPanel />);

    expect(view.all("tbody tr").length).toBe(2);
    expect(view.text()).toContain("Laptop");
    expect(view.text()).toContain("Phone");
  });

  test("a passkey with no name or date renders placeholders", async () => {
    client.passkey.listUserPasskeys = ok([
      passkey({ id: "pk1", name: null, createdAt: null }),
      passkey({ id: "pk2" }),
    ]);
    const view = await mountAsync(<PasskeysPanel />);

    const cells = view.all("tbody tr")[0]?.querySelectorAll("td") ?? [];
    expect(cells[0]?.textContent).toBe("-");
    expect(cells[1]?.textContent).toBe("-");
  });

  test("a date is rendered in the reader's own locale format", async () => {
    const createdAt = new Date("2026-03-04T05:06:07Z");
    client.passkey.listUserPasskeys = ok([
      passkey({ createdAt }),
      passkey({ id: "pk2" }),
    ]);
    const view = await mountAsync(<PasskeysPanel />);

    expect(
      view.all("tbody tr")[0]?.querySelectorAll("td")[1]?.textContent,
    ).toBe(createdAt.toLocaleString());
  });

  test("a failed list shows the reason and no second, wrong claim", async () => {
    client.passkey.listUserPasskeys = refuse("authentication required");
    const view = await mountAsync(<PasskeysPanel />);

    expect(view.find(".error").textContent).toBe("authentication required");
    // "No passkeys" beside the error would be a claim the panel cannot make.
    expect(view.maybe(".empty")).toBeNull();
  });

  test("a list that throws is caught", async () => {
    client.passkey.listUserPasskeys = explode("network is down");
    const view = await mountAsync(<PasskeysPanel />);

    expect(view.find(".error").textContent).toBe("network is down");
    expect(view.maybe(".empty")).toBeNull();
  });

  test("a refusal with no message falls back", async () => {
    client.passkey.listUserPasskeys = async () => ({ data: null, error: {} });
    const view = await mountAsync(<PasskeysPanel />);

    expect(view.find(".error").textContent).toBe("could not list passkeys");
  });

  test("a list answering with no data is treated as empty", async () => {
    client.passkey.listUserPasskeys = ok(null);
    const view = await mountAsync(<PasskeysPanel />);

    expect(view.find(".empty").textContent).toBe("No passkeys.");
  });
});

describe("PasskeysPanel adding", () => {
  test("the new passkey is numbered after the ones already held", async () => {
    let named: unknown;
    client.passkey.listUserPasskeys = ok([passkey(), passkey({ id: "pk2" })]);
    client.passkey.addPasskey = async (options: unknown) => {
      named = options;
      return { data: { id: "pk3" }, error: null };
    };
    const view = await mountAsync(<PasskeysPanel />);

    await click(view.byText("button", "Add a passkey"));

    expect(named).toEqual({ name: "Passkey 3" });
  });

  test("a successful ceremony refreshes the list", async () => {
    let listed = 0;
    client.passkey.listUserPasskeys = async () => {
      listed += 1;
      return { data: listed > 1 ? [passkey()] : [], error: null };
    };
    client.passkey.addPasskey = ok({ id: "pk1" });
    const view = await mountAsync(<PasskeysPanel />);

    await click(view.byText("button", "Add a passkey"));

    expect(listed).toBe(2);
    expect(view.all("tbody tr").length).toBe(1);
  });

  test("a cancelled ceremony is reported and changes nothing", async () => {
    client.passkey.addPasskey = refuse("The operation was aborted.");
    const view = await mountAsync(<PasskeysPanel />);

    await click(view.byText("button", "Add a passkey"));

    expect(view.find(".error").textContent).toBe("The operation was aborted.");
  });

  test("a ceremony that throws is caught rather than left unhandled", async () => {
    client.passkey.addPasskey = explode("NotAllowedError");
    const view = await mountAsync(<PasskeysPanel />);

    await click(view.byText("button", "Add a passkey"));

    expect(view.find(".error").textContent).toBe("NotAllowedError");
  });

  test("a refusal with no message falls back", async () => {
    client.passkey.addPasskey = async () => ({ data: null, error: {} });
    const view = await mountAsync(<PasskeysPanel />);

    await click(view.byText("button", "Add a passkey"));

    expect(view.find(".error").textContent).toBe("could not add a passkey");
  });

  test("an undefined outcome counts as success, and the list is re-read", async () => {
    // The refresh is the only thing that puts the new key on the page - the
    // panel never appends the row itself - so a success that skipped it would
    // leave the visitor looking at a list without the passkey they just made.
    let listed: PasskeyRow[] = [];
    client.passkey.listUserPasskeys = async () => ({
      data: listed,
      error: null,
    });
    client.passkey.addPasskey = async () => {
      listed = [passkey({ id: "pk9", name: "Fresh" })];
      return undefined;
    };
    const view = await mountAsync(<PasskeysPanel />);
    expect(view.all("tbody tr").length).toBe(0);

    await click(view.byText("button", "Add a passkey"));

    expect(view.maybe(".error")).toBeNull();
    expect(view.all("tbody tr").length).toBe(1);
    expect(view.text()).toContain("Fresh");
  });

  test("the button is held while the ceremony runs and released after", async () => {
    const ceremony = deferred<void>();
    client.passkey.addPasskey = async () => {
      await ceremony.answer();
      return { data: { id: "pk1" }, error: null };
    };
    const view = await mountAsync(<PasskeysPanel />);
    const button = view.byText<HTMLButtonElement>("button", "Add a passkey");

    button.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();
    expect(button.disabled).toBe(true);

    ceremony.release(undefined);
    await flush();
    expect(
      view.byText<HTMLButtonElement>("button", "Add a passkey").disabled,
    ).toBe(false);
  });
});

describe("PasskeysPanel deleting", () => {
  test("the last passkey has no Delete control, and the reason is on the page", async () => {
    client.passkey.listUserPasskeys = ok([passkey()]);
    const view = await mountAsync(<PasskeysPanel />);

    // Not a disabled button: a disabled control takes no focus, so its reason
    // would reach neither a keyboard nor a screen reader.
    expect(view.maybe("tbody button")).toBeNull();
    expect(view.find("tbody .muted").textContent).toBe(
      "Deleting your only passkey would lock you out",
    );
  });

  test("with two passkeys each row offers a Delete", async () => {
    client.passkey.listUserPasskeys = ok([
      passkey(),
      passkey({ id: "pk2", name: "Phone" }),
    ]);
    const view = await mountAsync(<PasskeysPanel />);

    const buttons = view.all("tbody button");
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Delete Laptop");
  });

  test("a nameless passkey still gets a distinguishable label", async () => {
    client.passkey.listUserPasskeys = ok([
      passkey({ name: null }),
      passkey({ id: "pk2" }),
    ]);
    const view = await mountAsync(<PasskeysPanel />);

    expect(view.all("tbody button")[0]?.getAttribute("aria-label")).toBe(
      "Delete this passkey",
    );
  });

  test("deleting sends the id and refreshes", async () => {
    let deleted: unknown;
    let listed = 0;
    client.passkey.listUserPasskeys = async () => {
      listed += 1;
      return {
        data: listed > 1 ? [passkey()] : [passkey(), passkey({ id: "pk2" })],
        error: null,
      };
    };
    client.passkey.deletePasskey = async (options: unknown) => {
      deleted = options;
      return { data: { success: true }, error: null };
    };
    const view = await mountAsync(<PasskeysPanel />);

    await click(rowButton(view, 1));

    expect(deleted).toEqual({ id: "pk2" });
    expect(view.all("tbody tr").length).toBe(1);
  });

  test("two presses in one tick delete once, not twice", async () => {
    /*
     * Both dispatched before any re-render, which is the whole window the ref
     * exists for: `busy` is state, so the second handler would read the value
     * the first one closed over. Awaiting between the presses would instead be
     * testing `disabled`, which is a hint to a person and never guarded a call.
     */
    const removal = deferred<{ data: { success: boolean }; error: null }>();
    let deletions = 0;
    client.passkey.listUserPasskeys = ok([passkey(), passkey({ id: "pk2" })]);
    client.passkey.deletePasskey = async () => {
      deletions += 1;
      return await removal.answer();
    };
    const view = await mountAsync(<PasskeysPanel />);

    const button = rowButton(view, 0);
    button.dispatchEvent(new Event("click", { bubbles: true }));
    button.dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(deletions).toBe(1);
    // And the row is held while that one is out.
    expect(rowButton(view, 0)).toHaveProperty("disabled", true);

    removal.release({ data: { success: true }, error: null });
    await flush();
    expect(deletions).toBe(1);
  });

  test("a refused delete leaves both rows in place", async () => {
    client.passkey.listUserPasskeys = ok([passkey(), passkey({ id: "pk2" })]);
    client.passkey.deletePasskey = refuse("cannot delete the last passkey");
    const view = await mountAsync(<PasskeysPanel />);

    await click(rowButton(view, 0));

    expect(view.find(".error").textContent).toBe(
      "cannot delete the last passkey",
    );
    expect(view.all("tbody tr").length).toBe(2);
  });

  test("a blank refusal reads as the fallback, not an empty line", async () => {
    // `?? fallback` only catches an absent message; a whitespace-only one
    // rendered an error line with nothing in it, which reads as no error.
    client.passkey.listUserPasskeys = ok([passkey(), passkey({ id: "pk2" })]);
    client.passkey.deletePasskey = async () => ({
      data: null,
      error: { message: "   " },
    });
    const view = await mountAsync(<PasskeysPanel />);

    await click(rowButton(view, 0));

    expect(view.find(".error").textContent).toBe(
      "could not delete the passkey",
    );
  });

  test("a delete that throws is caught", async () => {
    client.passkey.listUserPasskeys = ok([passkey(), passkey({ id: "pk2" })]);
    client.passkey.deletePasskey = explode("network is down");
    const view = await mountAsync(<PasskeysPanel />);

    await click(rowButton(view, 0));

    expect(view.find(".error").textContent).toBe("network is down");
  });

  test("a refusal with no message falls back", async () => {
    client.passkey.listUserPasskeys = ok([passkey(), passkey({ id: "pk2" })]);
    client.passkey.deletePasskey = async () => ({ data: null, error: {} });
    const view = await mountAsync(<PasskeysPanel />);

    await click(rowButton(view, 0));

    expect(view.find(".error").textContent).toBe(
      "could not delete the passkey",
    );
  });

  test("a successful delete clears a previous error", async () => {
    client.passkey.listUserPasskeys = ok([passkey(), passkey({ id: "pk2" })]);
    client.passkey.deletePasskey = refuse("try again");
    const view = await mountAsync(<PasskeysPanel />);
    await click(rowButton(view, 0));
    expect(view.maybe(".error")).not.toBeNull();

    client.passkey.deletePasskey = ok({ success: true });
    await click(rowButton(view, 0));

    expect(view.maybe(".error")).toBeNull();
  });
});

test("the scrolling table is reachable by keyboard", async () => {
  client.passkey.listUserPasskeys = ok([passkey()]);
  const view = await mountAsync(<PasskeysPanel />);
  const region = view.find(".table-scroll");

  expect(region.getAttribute("tabindex")).toBe("0");
  expect(region.getAttribute("aria-label")).toBe("Passkeys");
});
