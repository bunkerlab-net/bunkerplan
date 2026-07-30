import "./dom-env.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { PlanGate } from "../../src/client/PlanGate.tsx";
import { api, calls, countOf, useApiStub } from "./api-stub.ts";
import {
  client,
  navigations,
  ok,
  PENDING,
  refuse,
  replacements,
  setSession,
  signedIn,
  useAuthStub,
} from "./auth-stub.ts";
import type { Mounted } from "./harness.tsx";
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

const gate = (over: { hasCode?: boolean; relay?: boolean } = {}) => (
  <PlanGate
    name="gate"
    planId={PLAN_ID}
    hasCode={over.hasCode ?? true}
    // The refusal page unless a test says otherwise; `/s/{id}` is the relay a
    // share link lands on, and it is covered on its own below.
    path={over.relay === true ? `/s/${PLAN_ID}` : `/p/${PLAN_ID}`}
    relay={over.relay ?? false}
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
    // The only control here is the nav's own Sign out; pressing sign-in again
    // would change nothing, so the gate offers no passkey button.
    expect(view.byText("button.btn-text", "Sign out")).not.toBeNull();
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

/** Puts the browser on the URL a code-bearing link actually lands on. */
const standOn = (url: string): void => {
  history.replaceState(null, "", url);
};

/*
 * One cleanup for the file. Three suites below stand the browser on a URL, and
 * a copy of this in each is a copy that can be forgotten: the address bar is
 * process-wide, so a suite that left one behind would change what the next one
 * reads out of `location`.
 */
afterEach(() => {
  standOn("/");
});

describe("unlocking with a code", () => {
  /**
   * A submit dispatched synchronously, the way a keypress delivers one.
   *
   * Not `submitForm`, which awaits a flush: the latch tests below need the
   * dispatch to return before the next one starts.
   *
   * A `CustomEvent` carrying a `detail` for the reason `submitForm` gives:
   * `hono/jsx`'s intrinsic `form` reads an untrusted event's action out of
   * `event.detail`, and a bare `Event` makes that listener throw past the
   * assertions while the test still passes.
   */
  const submitNow = (view: Mounted): void => {
    view.find("form").dispatchEvent(
      new CustomEvent("submit", {
        bubbles: true,
        cancelable: true,
        detail: {},
      }),
    );
  };

  test("a code is traded for the cookie and the plan loaded bare", async () => {
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
    /*
     * Replaced rather than assigned, and built from the plan id rather than the
     * path this page was served at: the same component renders at `/s/{id}`,
     * where reloading the current path would come straight back here.
     *
     * Nothing of the old URL survives. The query held the code and reloading it
     * would keep that in history and in the `Referer` of everything the plan
     * fetches; the fragment goes too, because by here it cannot hold anything
     * this page did not already take out.
     */
    expect(replacements).toEqual([`/p/${PLAN_ID}`]);
    expect(navigations).toEqual([]);
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
      submitNow(view);
    }
    await flush();

    expect(countOf("unlockPlan")).toBe(1);
    attempt.release();
    await flush();
  });

  test("a successful unlock keeps the latch closed as the page leaves", async () => {
    standOn(`/p/${PLAN_ID}`);
    api.unlockPlan = async () => undefined;
    const view = await mountAsync(gate());
    await type(view.find<HTMLInputElement>('input[type="text"]'), "abcd1234");

    for (let round = 0; round < 2; round++) {
      submitNow(view);
      await flush();
    }

    /*
     * The counterpart to the refusal case above, and the reason the latch is
     * released in `catch` rather than in a `finally`. `replace()` does not
     * unload the document here, so this component is still mounted and still
     * submittable; a `finally` would let the second submit through. In a browser
     * that lands while the unlocked document is already loading.
     */
    expect(countOf("unlockPlan")).toBe(1);
    expect(replacements).toEqual([`/p/${PLAN_ID}`]);
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
      submitNow(view);
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
    // Set explicitly: the stub's default session is already resolved, so
    // without this the two controls below are live and the count this test
    // used to make was satisfied by Unlock, which the empty code box disables.
    setSession(PENDING);
    const view = mount(gate());
    /*
     * Named rather than counted. At this point Unlock is also disabled, because
     * the code box is empty, so "at least one disabled button" would hold even
     * if both of these were live.
     */
    expect(
      view.byText<HTMLButtonElement>("button", "Sign in with passkey").disabled,
    ).toBe(true);
    expect(
      view.byText<HTMLButtonElement>(".nav-right button", "Sign in").disabled,
    ).toBe(true);
  });
});

/**
 * The link the dashboard hands out carries the code as `#code=`, because a
 * fragment is never sent to a server: no access log, no proxy, no `Referer`.
 * What is left is this browser's own history, so the gate takes it out of the
 * address bar before it spends it rather than after - a wrong code or a dropped
 * connection would otherwise leave it sitting there.
 *
 * `?code=` still exists for a reader without a DOM and is covered above.
 */
describe("a link that brought its own code", () => {
  test("spends it on arrival, with nothing to press", async () => {
    standOn(`/p/${PLAN_ID}#code=abcd1234`);
    api.unlockPlan = async () => undefined;

    await mountAsync(gate());

    expect(calls.filter((c) => c.method === "unlockPlan")[0]?.args).toEqual([
      PLAN_ID,
      "abcd1234",
    ]);
    expect(replacements).toEqual([`/p/${PLAN_ID}`]);
  });

  test("trims it, the same as a code typed into the box", async () => {
    // A link can carry padding just as a paste can: `%20` either side survives
    // encoding, and the server compares a digest so it cannot forgive one.
    // Trimming only the box's own value would refuse a code the box would take.
    standOn(`/p/${PLAN_ID}#code=%20abcd1234%20`);
    api.unlockPlan = async () => undefined;

    await mountAsync(gate());

    expect(calls.filter((c) => c.method === "unlockPlan")[0]?.args).toEqual([
      PLAN_ID,
      "abcd1234",
    ]);
  });

  test("a fragment that is only padding is no code at all", async () => {
    // `%20%20` decodes to spaces and trims to nothing. Posting that would spend
    // an attempt on a string the server can only refuse, and showing an error
    // would blame the reader for a link that carried nothing.
    standOn(`/p/${PLAN_ID}#code=%20%20`);

    const view = await mountAsync(gate());

    expect(countOf("unlockPlan")).toBe(0);
    expect(view.maybe('[role="alert"]')).toBeNull();
    // Taken out of the address bar even so: it was meant to be a secret.
    expect(window.location.hash).toBe("");
  });

  test("padding on the relay forwards rather than stranding the reader", async () => {
    /*
     * Nothing was spent, so the relay has nothing left to do and must hand the
     * reader on. Treating a fragment that trims away as a spend would leave
     * them on `/s/{id}`, a page whose only job is to get out of the way, while
     * a session or an earlier cookie may already let them read the plan.
     */
    standOn(`/s/${PLAN_ID}#code=%20%20`);

    const view = await mountAsync(gate({ relay: true }));

    expect(countOf("unlockPlan")).toBe(0);
    expect(replacements).toEqual([`/p/${PLAN_ID}`]);
    expect(view.maybe('[role="alert"]')).toBeNull();
  });

  test("decodes it, matching what the dashboard encoded", async () => {
    standOn(`/p/${PLAN_ID}#code=a%20b%26c%3Dd`);
    api.unlockPlan = async () => undefined;

    await mountAsync(gate());

    expect(calls.filter((c) => c.method === "unlockPlan")[0]?.args[1]).toBe(
      "a b&c=d",
    );
  });

  test("takes it out of the address bar before spending it", async () => {
    standOn(`/p/${PLAN_ID}#code=abcd1234`);
    api.unlockPlan = async () => {
      throw new Error("wrong code");
    };

    const view = await mountAsync(gate());

    // The refusal is the point: the code is already gone from the URL, so a
    // reader whose code was wrong has not left it in their history.
    expect(window.location.hash).toBe("");
    expect(view.find('[role="alert"]').textContent).toBe("wrong code");
    expect(replacements).toEqual([]);
    // And it is in the box, so the next press is a retry rather than a hunt for
    // the link again.
    expect(view.find<HTMLInputElement>('input[type="text"]').value).toBe(
      "abcd1234",
    );
  });

  test("does not spend one the plan no longer has, and still strips it", async () => {
    // A link outlives the sharing it was made under: the owner can revoke the
    // code and leave the plan private. Posting a stale one would fail into a
    // form this page does not render for a plan with no code, so the reader
    // would see nothing while the attempt spent from a rate-limit bucket keyed
    // on their address.
    standOn(`/p/${PLAN_ID}#code=revoked1234`);

    await mountAsync(gate({ hasCode: false }));

    expect(countOf("unlockPlan")).toBe(0);
    expect(window.location.hash).toBe("");
  });

  test("leaves an ordinary fragment alone", async () => {
    standOn(`/p/${PLAN_ID}#section-3`);

    await mountAsync(gate());

    expect(countOf("unlockPlan")).toBe(0);
    expect(window.location.hash).toBe("#section-3");
  });

  test("a malformed escape is not a code", async () => {
    // `decodeURIComponent` throws on a stray `%`. Treated as no code at all -
    // the box is offered - rather than posting the raw text or showing an error
    // about an encoding the reader cannot do anything about.
    standOn(`/p/${PLAN_ID}#code=%`);

    const view = await mountAsync(gate());

    expect(countOf("unlockPlan")).toBe(0);
    expect(view.maybe('[role="alert"]')).toBeNull();
    expect(view.find<HTMLInputElement>('input[type="text"]').value).toBe("");
  });
});

/**
 * The relay at `/s/{id}`, which is where a share link actually points.
 *
 * Same component, rendered at the app's own path rather than the plan's, so the
 * code in the fragment is never held by a page that also serves untrusted HTML.
 * Its extra job is to get out of the way: whenever there is nothing to spend it
 * hands the reader to `/p/{id}`, which is what decides whether they may read it.
 */
describe("the share-link relay", () => {
  test("spends the fragment code and sends the reader to the plan", async () => {
    standOn(`/s/${PLAN_ID}#code=abcd1234`);
    api.unlockPlan = async () => undefined;

    await mountAsync(gate({ relay: true }));

    expect(calls.filter((c) => c.method === "unlockPlan")[0]?.args).toEqual([
      PLAN_ID,
      "abcd1234",
    ]);
    // To the plan, not back to `/s/{id}` - and the code is gone from the URL
    // before the navigation, so the document never sees it.
    expect(replacements).toEqual([`/p/${PLAN_ID}`]);
    expect(window.location.hash).toBe("");
  });

  test("forwards a bare visit rather than claiming the plan is private", async () => {
    // No code to spend, so nothing for this page to do. The reader may hold
    // access already - a session, a grant, a cookie from an earlier redemption -
    // and `/p/{id}` is what knows.
    standOn(`/s/${PLAN_ID}`);

    await mountAsync(gate({ relay: true }));

    expect(countOf("unlockPlan")).toBe(0);
    expect(replacements).toEqual([`/p/${PLAN_ID}`]);
  });

  test("strips a revoked code and forwards rather than dead-ending", async () => {
    /*
     * A link outlives the sharing it was made under: the owner can remove the
     * code and leave the plan private. The fragment then cannot be spent, and
     * leaving the reader here would show them "this plan is private" with no box
     * to type into and no way onward - while they may hold access anyway.
     */
    standOn(`/s/${PLAN_ID}#code=revoked1234`);

    await mountAsync(gate({ relay: true, hasCode: false }));

    expect(countOf("unlockPlan")).toBe(0);
    // Stripped even though it bought nothing: a dead code is still a secret
    // that was.
    expect(window.location.hash).toBe("");
    expect(replacements).toEqual([`/p/${PLAN_ID}`]);
  });

  test("a refused code keeps the reader here, with the box and the reason", async () => {
    standOn(`/s/${PLAN_ID}#code=wrongcode123`);
    api.unlockPlan = async () => {
      throw new Error("wrong code");
    };

    const view = await mountAsync(gate({ relay: true }));

    // Not forwarded: there is something to do here, which is try again.
    expect(replacements).toEqual([]);
    expect(view.find('[role="alert"]').textContent).toBe("wrong code");
    expect(view.find<HTMLInputElement>('input[type="text"]').value).toBe(
      "wrongcode123",
    );
    expect(window.location.hash).toBe("");
  });
});
