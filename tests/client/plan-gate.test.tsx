import "./dom-env.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { PlanGate } from "../../src/client/PlanGate.tsx";
import { api, calls, countOf, useApiStub } from "./api-stub.ts";
import {
  client,
  navigations,
  ok,
  refuse,
  replacements,
  setSession,
  signedIn,
  useAuthStub,
} from "./auth-stub.ts";
import {
  click,
  deferred,
  flush,
  mount,
  mountAsync,
  submitForm,
  type,
  useHarness,
} from "./harness.tsx";

// Arms the module stubs for this file; unarmed, the real modules answer.
useHarness();
useApiStub();
useAuthStub();

/**
 * The page a visitor gets when a plan exists but they may not read it.
 *
 * Two ways through and no third, so the suite pins both and what happens when
 * each is refused. The navigation after a successful unlock is the subtle
 * part: it has to be a full document load, to the bare path, replacing the
 * history entry - whatever got here may carry `?code=` in the URL, and
 * reloading it would leave the code in history and in the `Referer` of
 * everything the plan goes on to fetch.
 */

const PLAN_ID = "abc123";

const gate = (over: { hasCode?: boolean } = {}) => (
  <PlanGate
    name="gate"
    planId={PLAN_ID}
    hasCode={over.hasCode ?? true}
    path={`/p/${PLAN_ID}`}
    origin="https://plans.test"
  />
);

describe("what the gate says", () => {
  test("reveals nothing about the document itself", async () => {
    const view = await mountAsync(gate());

    expect(view.find(".page-title").textContent).toBe("This plan is private.");
    expect(view.text()).toContain(
      "Nothing about the document itself is revealed here.",
    );
  });

  test("a plan with no code offers only the account way in", async () => {
    const view = await mountAsync(gate({ hasCode: false }));

    expect(view.maybe('input[type="text"]')).toBeNull();
    expect(view.text()).toContain("Sign in");
    // With one way in, that control takes the page's single accent.
    expect(view.byText("button", "Sign in with passkey").className).toBe(
      "btn-clay",
    );
  });

  test("a plan with a code makes the code the primary path", async () => {
    const view = await mountAsync(gate());

    expect(view.byText("button", "Unlock").className).toBe("btn-clay");
    expect(view.byText("button", "Sign in with passkey").className).toBe(
      "btn-text",
    );
    expect(view.text()).toContain("Or sign in");
  });

  test("a signed-in visitor is told their own account is the one refused", async () => {
    setSession(signedIn("brisk-heron"));
    const view = await mountAsync(gate());

    expect(view.text()).toContain("Signed in as brisk-heron");
    expect(view.text()).toContain("Ask its owner to share it with");
    // Nothing to press: signing in again would change nothing.
    expect(view.maybe("button.btn-text")).not.toBeNull();
    expect(
      view
        .all("button")
        .some((node) => node.textContent === "Sign in with passkey"),
    ).toBe(false);
  });

  test("the nav carries the handle once the session resolves", async () => {
    setSession(signedIn("brisk-heron"));
    const view = await mountAsync(gate());

    expect(view.find(".nav-handle").textContent).toContain("brisk-heron");
  });
});

describe("unlocking with a code", () => {
  /** Puts the browser on the URL a code-bearing link actually lands on. */
  const standOn = (url: string): void => {
    history.replaceState(null, "", url);
  };

  afterEach(() => {
    standOn("/");
  });

  test("a code is traded for the cookie and the page reloaded bare", async () => {
    // The URL someone is handed: the code is in the query, and the fragment
    // may mean something to the document.
    standOn(`/p/${PLAN_ID}?code=the-secret#section-3`);
    api.unlockPlan = async () => undefined;
    const view = await mountAsync(gate());

    await type(view.find<HTMLInputElement>('input[type="text"]'), "abcd1234");
    await submitForm(view.find("form"));

    expect(calls.filter((c) => c.method === "unlockPlan")[0]?.args).toEqual([
      PLAN_ID,
      "abcd1234",
    ]);
    // Replaced, not assigned, and stripped of the query: reloading the URL as
    // it stands would keep the code in history and put it in the `Referer` of
    // everything the plan goes on to fetch. The hash is not a secret and is
    // kept.
    expect(replacements).toEqual([`/p/${PLAN_ID}#section-3`]);
    expect(navigations).toEqual([]);
  });

  test("a plan URL with no query or hash reloads as itself", async () => {
    standOn(`/p/${PLAN_ID}`);
    api.unlockPlan = async () => undefined;
    const view = await mountAsync(gate());

    await type(view.find<HTMLInputElement>('input[type="text"]'), "abcd1234");
    await submitForm(view.find("form"));

    expect(replacements).toEqual([`/p/${PLAN_ID}`]);
  });

  test("a pasted code is trimmed, because the server compares a digest", async () => {
    api.unlockPlan = async () => undefined;
    const view = await mountAsync(gate());

    await type(
      view.find<HTMLInputElement>('input[type="text"]'),
      "  abcd1234\n",
    );
    await submitForm(view.find("form"));

    expect(calls.filter((c) => c.method === "unlockPlan")[0]?.args[1]).toBe(
      "abcd1234",
    );
  });

  test("Unlock is dead until the code has something in it", async () => {
    const view = await mountAsync(gate());
    expect(view.byText<HTMLButtonElement>("button", "Unlock").disabled).toBe(
      true,
    );

    await type(view.find<HTMLInputElement>('input[type="text"]'), "   ");
    expect(view.byText<HTMLButtonElement>("button", "Unlock").disabled).toBe(
      true,
    );

    await type(view.find<HTMLInputElement>('input[type="text"]'), "x");
    expect(view.byText<HTMLButtonElement>("button", "Unlock").disabled).toBe(
      false,
    );
  });

  test("Enter on an empty box submits nothing, though the form still fires", async () => {
    const view = await mountAsync(gate());

    const event = await submitForm(view.find("form"));

    expect(countOf("unlockPlan")).toBe(0);
    expect(event.defaultPrevented).toBe(true);
  });

  test("a wrong code is announced, not merely printed", async () => {
    api.unlockPlan = async () => {
      throw new Error("wrong code");
    };
    const view = await mountAsync(gate());

    await type(view.find<HTMLInputElement>('input[type="text"]'), "nope");
    await submitForm(view.find("form"));

    const alert = view.find('[role="alert"]');
    expect(alert.textContent).toBe("wrong code");
    // A wrong code is the expected outcome here, so the box points at the
    // message rather than leaving a screen reader to find it.
    expect(
      view.find('input[type="text"]').getAttribute("aria-describedby"),
    ).toBe(alert.id);
    expect(replacements).toEqual([]);
  });

  test("with no error the box describes nothing", async () => {
    const view = await mountAsync(gate());

    expect(
      view.find('input[type="text"]').getAttribute("aria-describedby"),
    ).toBeNull();
  });

  test("a rate limit names the wait it was given", async () => {
    api.unlockPlan = async () => {
      throw new Error("Too many attempts. Try again in 42 seconds.");
    };
    const view = await mountAsync(gate());

    await type(view.find<HTMLInputElement>('input[type="text"]'), "nope");
    await submitForm(view.find("form"));

    expect(view.find('[role="alert"]').textContent).toBe(
      "Too many attempts. Try again in 42 seconds.",
    );
  });

  test("a non-Error rejection reads as the shared fallback", async () => {
    api.unlockPlan = async () => {
      throw "the request was aborted";
    };
    const view = await mountAsync(gate());

    await type(view.find<HTMLInputElement>('input[type="text"]'), "nope");
    await submitForm(view.find("form"));

    // Not the thrown string: `messageOf` renders wording this app chose rather
    // than whatever value happened to be thrown, the same as every panel.
    expect(view.find('[role="alert"]').textContent).toBe(
      "could not unlock the plan",
    );
  });

  test("an Error with an empty message falls back rather than blanking", async () => {
    api.unlockPlan = async () => {
      throw new Error("");
    };
    const view = await mountAsync(gate());

    await type(view.find<HTMLInputElement>('input[type="text"]'), "nope");
    await submitForm(view.find("form"));

    expect(view.find('[role="alert"]').textContent).toBe(
      "could not unlock the plan",
    );
  });

  test("the box is held while the attempt is in flight and released on refusal", async () => {
    const attempt = deferred<void>();
    api.unlockPlan = () =>
      attempt.answer().then(() => {
        throw new Error("wrong code");
      });
    const view = await mountAsync(gate());
    await type(view.find<HTMLInputElement>('input[type="text"]'), "nope");

    await submitForm(view.find("form"));
    expect(view.find<HTMLInputElement>('input[type="text"]').disabled).toBe(
      true,
    );

    attempt.release();
    await flush();
    expect(view.find<HTMLInputElement>('input[type="text"]').disabled).toBe(
      false,
    );
  });

  test("a second attempt does not start under the first one's message", async () => {
    const second = deferred<void>();
    let attempt = 0;
    api.unlockPlan = () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("wrong code"))
        : second.answer();
    };
    const view = await mountAsync(gate());
    await type(view.find<HTMLInputElement>('input[type="text"]'), "nope");
    await submitForm(view.find("form"));
    expect(view.maybe('[role="alert"]')).not.toBeNull();

    await type(view.find<HTMLInputElement>('input[type="text"]'), "better");
    await submitForm(view.find("form"));

    expect(view.maybe('[role="alert"]')).toBeNull();
    second.release();
    await flush();
  });

  test("hammering Enter spends one attempt, not one per press", async () => {
    const attempt = deferred<void>();
    api.unlockPlan = attempt.answer;
    const view = await mountAsync(gate());
    await type(view.find<HTMLInputElement>('input[type="text"]'), "abcd");

    // All in one turn, before any re-render can disable the controls. This
    // route is rate-limited per client address and a wrong code is the
    // expected outcome here, so one impatient reader must not be able to lock
    // themselves out three presses at a time.
    for (let press = 0; press < 3; press++) {
      view.find("form").dispatchEvent(
        new CustomEvent("submit", {
          bubbles: true,
          cancelable: true,
          detail: {},
        }),
      );
    }
    await flush();

    expect(countOf("unlockPlan")).toBe(1);
    attempt.release();
    await flush();
  });

  test("a refused attempt releases the latch, so it can be retried", async () => {
    let attempts = 0;
    api.unlockPlan = async () => {
      attempts += 1;
      throw new Error("wrong code");
    };
    const view = await mountAsync(gate());
    await type(view.find<HTMLInputElement>('input[type="text"]'), "nope");

    for (let round = 0; round < 2; round++) {
      view.find("form").dispatchEvent(
        new CustomEvent("submit", {
          bubbles: true,
          cancelable: true,
          detail: {},
        }),
      );
      await flush();
    }

    expect(attempts).toBe(2);
  });

  test("the box does not spell-check or autocomplete a secret", async () => {
    const view = await mountAsync(gate());
    const box = view.find('input[type="text"]');

    expect(box.getAttribute("autocomplete")).toBe("off");
    expect(box.getAttribute("spellcheck")).toBe("false");
    expect(box.getAttribute("aria-label")).toBe("Share code");
    // No `maxLength`: it would count the whitespace a paste brings, cutting
    // the tail off a code at the ceiling before the trim could help.
    expect(box.getAttribute("maxlength")).toBeNull();
  });
});

describe("signing in from the gate", () => {
  test("a successful ceremony returns to the plan, not the dashboard", async () => {
    client.signIn.passkey = ok({ user: { id: "u1" } });
    const view = await mountAsync(gate());

    await click(view.byText("button", "Sign in with passkey"));

    expect(navigations).toEqual([`/p/${PLAN_ID}`]);
  });

  test("a refused ceremony is announced beside the button", async () => {
    client.signIn.passkey = refuse("that account was not granted this plan");
    const view = await mountAsync(gate());

    await click(view.byText("button", "Sign in with passkey"));

    expect(view.byText('[role="alert"]', "not granted").textContent).toBe(
      "that account was not granted this plan",
    );
    expect(navigations).toEqual([]);
  });

  test("the nav's own sign-in runs the same ceremony", async () => {
    client.signIn.passkey = ok({ user: { id: "u1" } });
    const view = await mountAsync(gate());

    await click(view.byText(".nav-right button", "Sign in"));

    expect(navigations).toEqual([`/p/${PLAN_ID}`]);
  });

  test("both sign-in controls are held while the session is still resolving", () => {
    // The very first render, before the effect reads the session store: the
    // server could not know the session either, which is what makes the two
    // renders match.
    const view = mount(gate());

    expect(
      view.all<HTMLButtonElement>("button").filter((node) => node.disabled)
        .length,
    ).toBeGreaterThan(0);
  });
});
