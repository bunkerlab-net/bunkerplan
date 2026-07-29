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
import { click, mount, useHarness } from "./harness.tsx";

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
    expect(samePathOnly("/p/../dashboard", ORIGIN)).toBe("/dashboard");
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
  });

  test("a failure with no message reads as the shared fallback", async () => {
    client.signIn.passkey = explode("");
    const view = mount(<Runner />);

    await click(view.find("#signin"));

    expect(view.find(".error").textContent).toBe("authentication failed");
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
