import "./dom-env.ts";
import { describe, expect, test } from "bun:test";
import { samePathOnly, usePasskeyAction } from "../../src/client/passkey.ts";
import {
  client,
  explode,
  navigations,
  ok,
  refuse,
  useAuthStub,
} from "./auth-stub.ts";
import { click, deferred, flush, mount, useHarness } from "./harness.tsx";

// Arms the module stubs for this file; unarmed, the real modules answer.
useHarness();
useAuthStub();

/**
 * The one ceremony runner, and the redirect guard in front of it.
 *
 * `samePathOnly` is the only place this app hands a string to
 * `location.assign`, and the gate page feeds it a destination derived from a
 * URL, so it is tested as a control rather than as a formatter: everything
 * that is not a path on this origin has to come back as `/dashboard`.
 */

const ORIGIN = "https://plans.test";

describe("samePathOnly", () => {
  test("keeps a plain path", () => {
    expect(samePathOnly("/p/abc123", ORIGIN)).toBe("/p/abc123");
  });

  test("keeps the query and the fragment", () => {
    expect(samePathOnly("/p/abc?code=x#top", ORIGIN)).toBe("/p/abc?code=x#top");
  });

  test("refuses an absolute URL onto another origin", () => {
    expect(samePathOnly("https://evil.example/x", ORIGIN)).toBe("/dashboard");
  });

  test("refuses an absolute URL back onto this origin, which is not a path", () => {
    // Not because it is dangerous, but because the contract is "a path": an
    // input that is not one has already come from somewhere unexpected.
    expect(samePathOnly(`${ORIGIN}/p/abc`, ORIGIN)).toBe("/dashboard");
  });

  test("refuses a protocol-relative URL", () => {
    expect(samePathOnly("//evil.example/x", ORIGIN)).toBe("/dashboard");
  });

  test("refuses a path that is not rooted", () => {
    expect(samePathOnly("p/abc", ORIGIN)).toBe("/dashboard");
    expect(samePathOnly("", ORIGIN)).toBe("/dashboard");
  });

  test("refuses javascript: and data: destinations", () => {
    expect(samePathOnly("javascript:alert(1)", ORIGIN)).toBe("/dashboard");
    expect(samePathOnly("data:text/html,<script>x</script>", ORIGIN)).toBe(
      "/dashboard",
    );
  });

  test.each([
    ["a tab", "/\tevil.example"],
    ["a newline", "/\nevil.example"],
    ["a carriage return", "/\revil.example"],
    ["a backslash", "/\\evil.example"],
    ["a tab inside a scheme", "/java\tscript:alert(1)"],
  ])("refuses %s, which a URL parser strips before parsing", (_name, input) => {
    expect(samePathOnly(input, ORIGIN)).toBe("/dashboard");
  });

  test("refuses a path that normalises into a protocol-relative one", () => {
    // `/..//evil.example` resolves onto this origin with a pathname of
    // `//evil.example`; the leading-`//` test on the input cannot see it,
    // because normalisation is what produces it.
    expect(new URL("/..//evil.example", ORIGIN).pathname).toBe(
      "//evil.example",
    );
    expect(samePathOnly("/..//evil.example", ORIGIN)).toBe("/dashboard");
  });

  test("an unparseable origin lands on the default rather than throwing", () => {
    expect(samePathOnly("/p/abc", "not a url")).toBe("/dashboard");
  });

  test("a traversal that stays on the origin is left alone", () => {
    // Deliberately not `/p/../dashboard`: that normalises to `/dashboard`,
    // which is also the refusal fallback, so the assertion would hold whether
    // the traversal was accepted or rejected.
    expect(samePathOnly("/p/abc/../def", ORIGIN)).toBe("/p/def");
  });
});

function Runner({ destination }: { destination?: string }) {
  const { error, busy, register, signIn } = usePasskeyAction(destination);
  return (
    <div>
      <button type="button" id="register" disabled={busy} onClick={register}>
        register
      </button>
      <button type="button" id="signin" disabled={busy} onClick={signIn}>
        sign in
      </button>
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}

describe("usePasskeyAction", () => {
  test("a successful sign-in lands on the dashboard by default", async () => {
    client.signIn.passkey = ok({ user: { id: "u1" } });
    const view = mount(<Runner />);

    await click(view.find("#signin"));

    expect(navigations).toEqual(["/dashboard"]);
  });

  test("registration lands on the same default", async () => {
    client.passkey.addPasskey = ok({ id: "pk1" });
    const view = mount(<Runner />);

    await click(view.find("#register"));

    expect(navigations).toEqual(["/dashboard"]);
  });

  test("registration names the passkey it creates", async () => {
    let seen: unknown;
    client.passkey.addPasskey = async (options: unknown) => {
      seen = options;
      return { data: { id: "pk1" }, error: null };
    };
    const view = mount(<Runner />);

    await click(view.find("#register"));

    expect(seen).toEqual({ name: "Primary passkey" });
  });

  test("the gate's own destination survives a successful ceremony", async () => {
    client.signIn.passkey = ok({ user: { id: "u1" } });
    const view = mount(<Runner destination="/p/abc123" />);

    await click(view.find("#signin"));

    expect(navigations).toEqual(["/p/abc123"]);
  });

  test("an off-origin destination is refused at the point of navigation", async () => {
    client.signIn.passkey = ok({ user: { id: "u1" } });
    const view = mount(<Runner destination="//evil.example/steal" />);

    await click(view.find("#signin"));

    expect(navigations).toEqual(["/dashboard"]);
  });

  test("a returned refusal is shown and nothing navigates", async () => {
    client.signIn.passkey = refuse("no credential was offered");
    const view = mount(<Runner />);

    await click(view.find("#signin"));

    expect(view.find(".error").textContent).toBe("no credential was offered");
    expect(navigations).toEqual([]);
  });

  test("a thrown rejection reads the same as a returned one", async () => {
    client.signIn.passkey = explode("The operation was aborted.");
    const view = mount(<Runner />);

    await click(view.find("#signin"));

    expect(view.find(".error").textContent).toBe("The operation was aborted.");
    expect(navigations).toEqual([]);
    // The catch path has to release the buttons too. A ceremony the browser
    // aborts is the common case, and a visitor left facing two dead controls
    // has no way to try again.
    expect(view.find<HTMLButtonElement>("#signin").disabled).toBe(false);
    expect(view.find<HTMLButtonElement>("#register").disabled).toBe(false);
  });

  test("a failure with no message reads as the shared fallback", async () => {
    client.signIn.passkey = explode("");
    const view = mount(<Runner />);

    await click(view.find("#signin"));

    expect(view.find(".error").textContent).toBe("authentication failed");
  });

  test("both buttons are held while the ceremony is in flight", async () => {
    const ceremony = deferred<{ data: unknown; error: null }>();
    client.signIn.passkey = ceremony.answer;
    const view = mount(<Runner />);

    await click(view.find("#signin"));

    // Still unresolved: the pair has to be held for the whole ceremony, not
    // just re-enabled correctly once it lands, which is what the case below
    // covers.
    expect(view.find<HTMLButtonElement>("#signin").disabled).toBe(true);
    expect(view.find<HTMLButtonElement>("#register").disabled).toBe(true);

    ceremony.release({ data: null, error: null });
    await flush();

    /*
     * And still held once it lands, because a success navigates: `assign` is
     * called and `busy` is deliberately left set (src/client/passkey.ts), so the
     * pair cannot be pressed again while the page is leaving. The refusal case
     * below is the one that releases them.
     */
    expect(navigations).toEqual(["/dashboard"]);
    expect(view.find<HTMLButtonElement>("#signin").disabled).toBe(true);
    expect(view.find<HTMLButtonElement>("#register").disabled).toBe(true);
  });

  test("two presses in one tick run one ceremony, not two", async () => {
    /*
     * The window `disabled` cannot close. It needs a render and `busy` is
     * state, so a second handler dispatched before that render runs from the
     * enabled one - and WebAuthn answering twice means two credentials for a
     * visitor who pressed once, or a second prompt on top of the first.
     *
     * `inFlight` is the ref that closes it, kept separately from the
     * credentials panels' `useWriteLatch` because this success path is the
     * opposite one: it navigates and stays latched.
     */
    let attempts = 0;
    const ceremony = deferred<{ data: unknown; error: null }>();
    client.passkey.addPasskey = async () => {
      attempts += 1;
      return await ceremony.answer();
    };
    const view = mount(<Runner />);

    const press = () =>
      view
        .find("#register")
        .dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
    press();
    press();
    ceremony.release({ data: { id: "pk1" }, error: null });
    await flush();

    expect(attempts).toBe(1);
    expect(navigations).toEqual(["/dashboard"]);

    // And a third press, after the render the success produced. The latch is
    // deliberately never released on this path - the page is leaving - so this
    // is the difference between a guard against one turn and a guard that
    // holds until the document goes.
    press();
    await flush();

    expect(attempts).toBe(1);
    expect(navigations).toEqual(["/dashboard"]);
  });

  test("a refused ceremony can be pressed again in the next tick", async () => {
    // The latch is a guard against the same turn, not a one-shot: releasing it
    // on a refusal is what makes a cancelled prompt retryable, and a ref that
    // stayed set would leave the buttons enabled and inert.
    let attempts = 0;
    client.signIn.passkey = async () => {
      attempts += 1;
      return { data: null, error: { message: "cancelled" } };
    };
    const view = mount(<Runner />);

    await click(view.find("#signin"));
    await click(view.find("#signin"));

    expect(attempts).toBe(2);
  });

  test("a refusal releases the buttons so the ceremony can be retried", async () => {
    client.signIn.passkey = refuse("cancelled");
    const view = mount(<Runner />);

    await click(view.find("#signin"));

    expect(view.find<HTMLButtonElement>("#signin").disabled).toBe(false);
    expect(view.find<HTMLButtonElement>("#register").disabled).toBe(false);
  });

  test("an undefined outcome counts as success", async () => {
    // `addPasskey` resolves to `undefined` when the ceremony completed but the
    // plugin had nothing to report.
    client.passkey.addPasskey = async () => undefined;
    const view = mount(<Runner />);

    await click(view.find("#register"));

    expect(navigations).toEqual(["/dashboard"]);
    expect(view.maybe(".error")).toBeNull();
  });

  test("a second attempt clears the first attempt's error", async () => {
    client.signIn.passkey = refuse("cancelled");
    const view = mount(<Runner />);
    await click(view.find("#signin"));
    expect(view.maybe(".error")).not.toBeNull();

    client.signIn.passkey = ok({ user: { id: "u1" } });
    await click(view.find("#signin"));

    expect(view.maybe(".error")).toBeNull();
    expect(navigations).toEqual(["/dashboard"]);
  });
});
