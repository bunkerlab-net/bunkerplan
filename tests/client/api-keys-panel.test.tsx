import "./dom-env.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ApiKeysPanel,
  EXPIRY_CHOICES,
} from "../../src/client/ApiKeysPanel.tsx";
import { client, explode, ok, refuse, useAuthStub } from "./auth-stub.ts";
import {
  choose,
  click,
  deferred,
  flush,
  mount,
  mountAsync,
  type,
  useHarness,
} from "./harness.tsx";

// Arms the module stubs for this file; unarmed, the real modules answer.
useHarness();
useAuthStub();

/**
 * The panel that shows a secret exactly once.
 *
 * Two things carry the weight here. The plaintext key is returned by the
 * create call and never again, so the reveal has to appear on success and
 * survive until it is dismissed. And every mutation is fired as
 * `void create(...)` from a click handler, so a call that throws rather than
 * returning `{ error }` has to land on the error line - an unhandled rejection
 * would leave the panel looking like nothing happened.
 */

/** The row shape the panel renders, so a misspelled override is a type error. */
interface KeyRow {
  id: string;
  name: string | null;
  start: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

const key = (over: Partial<KeyRow> = {}): KeyRow => ({
  id: "k1",
  name: "CI",
  start: "bkp_abc",
  expiresAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

/** The list call every mount makes, staged with `rows`. */
function listing(rows: unknown[]): void {
  client.apiKey.list = ok({ apiKeys: rows });
}

beforeEach(() => {
  listing([]);
});

describe("ApiKeysPanel listing", () => {
  test("claims nothing while the first list is in flight", async () => {
    const pending = deferred<unknown[]>();
    client.apiKey.list = async () => ({
      data: { apiKeys: await pending.answer() },
      error: null,
    });

    const view = mount(<ApiKeysPanel />);
    await flush();
    // "No API keys." here would tell an account with several that it has none,
    // for as long as the request takes.
    expect(view.find(".empty").textContent).toBe("Loading…");

    pending.release([key()]);
    await flush();
    expect(view.all("tbody tr").length).toBe(1);
  });

  test("lists on mount and says so when there is nothing", async () => {
    const view = await mountAsync(<ApiKeysPanel />);

    expect(view.find(".empty").textContent).toBe("No API keys.");
    expect(view.maybe("table")).toBeNull();
  });

  test("renders a row per key", async () => {
    listing([key(), key({ id: "k2", name: "laptop", start: "bkp_xyz" })]);
    const view = await mountAsync(<ApiKeysPanel />);

    const rows = view.all("tbody tr");
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain("CI");
    // `start` already carries the prefix and must not have it prepended again.
    expect(rows[0]?.textContent).toContain("bkp_abc…");
    expect(rows[0]?.textContent).toContain("Never");
  });

  test("a key with no name and no prefix renders placeholders, not blanks", async () => {
    listing([key({ name: null, start: null })]);
    const view = await mountAsync(<ApiKeysPanel />);

    const cells = view.all("tbody td");
    expect(cells[0]?.textContent).toBe("-");
    expect(cells[1]?.textContent).toBe("-…");
  });

  test("an expiry is rendered as a date rather than as a timestamp", async () => {
    const expiresAt = new Date("2026-06-01T12:00:00Z");
    listing([key({ expiresAt })]);
    const view = await mountAsync(<ApiKeysPanel />);

    expect(view.all("tbody td")[2]?.textContent).toBe(
      expiresAt.toLocaleString(),
    );
  });

  test("a refused list shows the reason and no table", async () => {
    client.apiKey.list = refuse("authentication required");
    const view = await mountAsync(<ApiKeysPanel />);

    expect(view.find(".error").textContent).toBe("authentication required");
    expect(view.maybe("table")).toBeNull();
    // "No API keys." beside the error would be a second claim, and a wrong
    // one: the list never answered, so the panel does not know.
    expect(view.maybe(".empty")).toBeNull();
  });

  test("a list that throws is caught rather than left unhandled", async () => {
    client.apiKey.list = explode("network is down");
    const view = await mountAsync(<ApiKeysPanel />);

    expect(view.find(".error").textContent).toBe("network is down");
    expect(view.maybe(".empty")).toBeNull();
  });

  test("a refusal with no message falls back to a readable line", async () => {
    client.apiKey.list = async () => ({ data: null, error: {} });
    const view = await mountAsync(<ApiKeysPanel />);

    expect(view.find(".error").textContent).toBe("could not list API keys");
  });

  test("a list answering with no apiKeys field is treated as empty", async () => {
    client.apiKey.list = ok({});
    const view = await mountAsync(<ApiKeysPanel />);

    expect(view.find(".empty").textContent).toBe("No API keys.");
  });
});

describe("ApiKeysPanel creating", () => {
  /*
   * `navigator.clipboard` is one object for the whole process, so the stub one
   * test below installs would keep answering for every test after it. Declared
   * at the top of the block rather than beside that test, because a hook
   * registered mid-block still runs for all of them and reading it here is how
   * anyone would know that.
   */
  const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (realClipboard === undefined) {
      Reflect.deleteProperty(navigator, "clipboard");
    } else {
      Object.defineProperty(navigator, "clipboard", realClipboard);
    }
  });

  /**
   * Installs a `create` that records the options it is handed.
   *
   * `options` throws until the stub has actually been called. Seeding it with
   * `{}` would make the absence checks below pass on a create that never
   * happened, because `"expiresIn" in {}` is false either way.
   */
  const recordCreate = (): { readonly options: Record<string, unknown> } => {
    let recorded: Record<string, unknown> | undefined;
    client.apiKey.create = async (options: Record<string, unknown>) => {
      recorded = options;
      return { data: { key: "bkp_secret" }, error: null };
    };
    return {
      get options() {
        if (recorded === undefined) {
          throw new Error("apiKey.create was never called");
        }
        return recorded;
      },
    };
  };

  test("an unnamed key gets a default name rather than an empty one", async () => {
    const created = recordCreate();
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Create key"));

    expect(created.options).toEqual({ name: "API key" });
  });

  test("a name is trimmed before it is sent", async () => {
    const created = recordCreate();
    const view = await mountAsync(<ApiKeysPanel />);

    await type(view.find<HTMLInputElement>("input[type=text]"), "  CI  ");
    await click(view.byText("button", "Create key"));

    expect(created.options).toEqual({ name: "CI" });
  });

  test("a whitespace-only name is the same as no name", async () => {
    const created = recordCreate();
    const view = await mountAsync(<ApiKeysPanel />);

    await type(view.find<HTMLInputElement>("input[type=text]"), "   ");
    await click(view.byText("button", "Create key"));

    expect(created.options).toEqual({ name: "API key" });
  });

  test("the default expiry sends no expiresIn at all", async () => {
    const created = recordCreate();
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Create key"));

    expect("expiresIn" in created.options).toBe(false);
  });

  /*
   * Derived from the panel's own table, not restated. The option's value is
   * its index, so a reordered or newly added choice is covered here the moment
   * it ships - where a hand-written pairing would keep asserting the old
   * order and pass while the dropdown sent something else.
   *
   * `Never expires` is dropped: it sends no `expiresIn` at all, which the case
   * above pins.
   */
  const expiries = EXPIRY_CHOICES.flatMap((choice, index) =>
    choice.seconds === null
      ? []
      : [[String(index), choice.seconds, choice.label] as const],
  );

  test("the panel offers at least one expiry to choose", () => {
    // A named case rather than a bare assertion at module scope: a
    // configuration where every choice is `null` would register no cases below
    // at all, and a suite that runs nothing reports the same green as one that
    // proved something. Failing here says which.
    expect(expiries.length).toBeGreaterThan(0);
  });

  test.each(expiries)(
    "expiry choice %s sends %i seconds, the option labelled %s",
    async (index, seconds) => {
      const created = recordCreate();
      const view = await mountAsync(<ApiKeysPanel />);

      await choose(view.find<HTMLSelectElement>("select"), index);
      await click(view.byText("button", "Create key"));

      expect(created.options["expiresIn"]).toBe(seconds);
    },
  );

  test("a failed create clears the key the last one revealed", async () => {
    // Shown once, so what is on screen is the only copy its owner has - and
    // beside a failure it reads as the key that attempt produced.
    client.apiKey.create = ok({ key: "bkp_the_first_one" });
    const view = await mountAsync(<ApiKeysPanel />);
    await click(view.byText("button", "Create key"));
    expect(view.text()).toContain("bkp_the_first_one");

    client.apiKey.create = refuse("the key store is unreachable");
    await click(view.byText("button", "Create key"));

    expect(view.text()).not.toContain("bkp_the_first_one");
    expect(view.find(".error").textContent).toBe(
      "the key store is unreachable",
    );
  });

  test("the plaintext is revealed once and the name field is cleared", async () => {
    client.apiKey.create = ok({ key: "bkp_the_only_time" });
    const view = await mountAsync(<ApiKeysPanel />);
    const name = view.find<HTMLInputElement>("input[type=text]");

    await type(name, "CI");
    await click(view.byText("button", "Create key"));

    expect(view.find(".notice code").textContent).toBe("bkp_the_only_time");
    expect(name.value).toBe("");
  });

  test("the reveal can be dismissed, and it does not come back", async () => {
    client.apiKey.create = ok({ key: "bkp_the_only_time" });
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Create key"));
    await click(view.byText("button", "Dismiss"));

    expect(view.maybe(".notice")).toBeNull();
  });

  test("the reveal copies the key to the clipboard", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    });
    client.apiKey.create = ok({ key: "bkp_the_only_time" });
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Create key"));
    await click(view.byText("button", "Copy"));

    expect(copied).toEqual(["bkp_the_only_time"]);
  });

  test("a create that returns no key does not render an empty reveal", async () => {
    client.apiKey.create = ok({});
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Create key"));

    expect(view.maybe(".notice")).toBeNull();
  });

  test("a successful create refreshes the list", async () => {
    let listed = 0;
    client.apiKey.list = async () => {
      listed += 1;
      return { data: { apiKeys: listed > 1 ? [key()] : [] }, error: null };
    };
    client.apiKey.create = ok({ key: "bkp_secret" });
    const view = await mountAsync(<ApiKeysPanel />);
    expect(listed).toBe(1);

    await click(view.byText("button", "Create key"));

    expect(listed).toBe(2);
    expect(view.all("tbody tr").length).toBe(1);
  });

  test("a refused create keeps the typed name so it can be retried", async () => {
    client.apiKey.create = refuse("key limit reached");
    const view = await mountAsync(<ApiKeysPanel />);
    const name = view.find<HTMLInputElement>("input[type=text]");

    await type(name, "CI");
    await click(view.byText("button", "Create key"));

    expect(view.find(".error").textContent).toBe("key limit reached");
    expect(name.value).toBe("CI");
    expect(view.maybe(".notice")).toBeNull();
  });

  test("a create that throws lands on the error line", async () => {
    client.apiKey.create = explode("network is down");
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Create key"));

    expect(view.find(".error").textContent).toBe("network is down");
  });

  test("a refusal with no message falls back", async () => {
    client.apiKey.create = async () => ({ data: null, error: {} });
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Create key"));

    expect(view.find(".error").textContent).toBe("could not create API key");
  });

  test("the create button is held while the call is in flight", async () => {
    const creating = deferred<void>();
    client.apiKey.create = async () => {
      await creating.answer();
      return { data: { key: "bkp_secret" }, error: null };
    };
    const view = await mountAsync(<ApiKeysPanel />);
    const button = view.byText<HTMLButtonElement>("button", "Create key");

    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(button.disabled).toBe(true);

    creating.release(undefined);
    await flush();
    expect(
      view.byText<HTMLButtonElement>("button", "Create key").disabled,
    ).toBe(false);
  });

  test("two presses in one tick create one key, not two", async () => {
    /*
     * Both dispatched before any re-render, which is the window `disabled`
     * cannot close: it needs a render to appear, and `busy` is state, so both
     * handlers read the value their own render closed over. A second key here
     * is one the account never asked for, with its own plaintext shown once.
     */
    const creating = deferred<void>();
    let creates = 0;
    client.apiKey.create = async () => {
      creates += 1;
      await creating.answer();
      return { data: { key: "bkp_secret" }, error: null };
    };
    const view = await mountAsync(<ApiKeysPanel />);
    const button = view.byText<HTMLButtonElement>("button", "Create key");

    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();

    expect(creates).toBe(1);

    creating.release(undefined);
    await flush();
    expect(creates).toBe(1);
  });
});

describe("ApiKeysPanel revoking", () => {
  test("revoking sends the key id and refreshes", async () => {
    let revoked: unknown;
    let listed = 0;
    client.apiKey.list = async () => {
      listed += 1;
      return { data: { apiKeys: listed > 1 ? [] : [key()] }, error: null };
    };
    client.apiKey.delete = async (options: unknown) => {
      revoked = options;
      return { data: { success: true }, error: null };
    };
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Revoke"));

    expect(revoked).toEqual({ keyId: "k1" });
    expect(view.find(".empty").textContent).toBe("No API keys.");
  });

  test("a refused revoke leaves the row in place", async () => {
    listing([key()]);
    client.apiKey.delete = refuse("no such key");
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Revoke"));

    expect(view.find(".error").textContent).toBe("no such key");
    expect(view.all("tbody tr").length).toBe(1);
  });

  test("a revoke that throws lands on the error line", async () => {
    listing([key()]);
    client.apiKey.delete = explode("network is down");
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Revoke"));

    expect(view.find(".error").textContent).toBe("network is down");
  });

  test("a refusal with no message falls back", async () => {
    listing([key()]);
    client.apiKey.delete = async () => ({ data: null, error: {} });
    const view = await mountAsync(<ApiKeysPanel />);

    await click(view.byText("button", "Revoke"));

    expect(view.find(".error").textContent).toBe("could not revoke API key");
  });

  test("a successful revoke clears a previous error", async () => {
    listing([key()]);
    client.apiKey.delete = refuse("try again");
    const view = await mountAsync(<ApiKeysPanel />);
    await click(view.byText("button", "Revoke"));
    expect(view.maybe(".error")).not.toBeNull();

    client.apiKey.delete = ok({ success: true });
    await click(view.byText("button", "Revoke"));

    expect(view.maybe(".error")).toBeNull();
  });

  test("two presses in one tick revoke once, not twice", async () => {
    // The second call would answer "no such key" for a key this panel just
    // revoked successfully, so the row disappears and an error appears beside
    // it - a failure the account never had.
    listing([key()]);
    const revoking = deferred<void>();
    let revokes = 0;
    client.apiKey.delete = async () => {
      revokes += 1;
      await revoking.answer();
      return { data: { success: true }, error: null };
    };
    const view = await mountAsync(<ApiKeysPanel />);
    const button = view.byText<HTMLButtonElement>("button", "Revoke");

    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await flush();

    expect(revokes).toBe(1);

    revoking.release(undefined);
    await flush();
    expect(revokes).toBe(1);
    expect(view.maybe(".error")).toBeNull();
  });
});

describe("ApiKeysPanel accessibility", () => {
  test("both controls are labelled, because a placeholder is not a name", async () => {
    const view = await mountAsync(<ApiKeysPanel />);

    expect(view.find("input[type=text]").getAttribute("aria-label")).toBe(
      "Key name",
    );
    expect(view.find("select").getAttribute("aria-label")).toBe(
      "How long the key lasts",
    );
  });

  test("the scrolling table is reachable by keyboard", async () => {
    listing([key()]);
    const view = await mountAsync(<ApiKeysPanel />);
    const region = view.find(".table-scroll");

    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.getAttribute("aria-label")).toBe("API keys");
  });
});
