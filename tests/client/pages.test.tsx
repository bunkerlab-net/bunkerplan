import "./dom-env.ts";
import { describe, expect, test } from "bun:test";
import { NotFound } from "../../src/client/NotFound.tsx";
import { Page } from "../../src/client/pages.tsx";
import { api, useApiStub } from "./api-stub.ts";
import {
  client,
  navigations,
  ok,
  PENDING,
  refuse,
  SIGNED_OUT,
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
  useHarness,
} from "./harness.tsx";

// Arms the module stubs for this file; unarmed, the real modules answer.
useHarness();
useApiStub();
useAuthStub();

/**
 * The three pages and the chrome they share, driven through `Page` - the same
 * entry point `entry.tsx` hydrates with, so what is exercised here is what the
 * browser actually runs.
 *
 * The session is the axis everything turns on, and it has three states rather
 * than two: resolving, resolved-signed-out, and failed. Conflating the first
 * with the second is what would make the dashboard bounce a signed-in reader
 * back to the landing page over one dropped request.
 */

const ORIGIN = "https://plans.test";

const landing = () => <Page name="landing" path="/" origin={ORIGIN} />;
const dashboard = () => (
  <Page name="dashboard" path="/dashboard" origin={ORIGIN} />
);

/** Every panel on the dashboard lists on mount; none of that is under test. */
function quietDashboard(): void {
  api.listPlans = async () => [];
  client.apiKey.list = ok({ apiKeys: [] });
  client.passkey.listUserPasskeys = ok([]);
}

describe("the landing page", () => {
  test("leads with what the product does", async () => {
    const view = await mountAsync(landing());

    expect(view.find(".hero-title").textContent).toBe(
      "Upload one HTML file. Get a URL that opens.",
    );
  });

  test("offers both ceremonies to a signed-out visitor", async () => {
    const view = await mountAsync(landing());

    expect(view.byText("button", "Create an account")).not.toBeNull();
    expect(view.byText("button", "I already have one")).not.toBeNull();
    expect(view.text()).toContain("No email, no password, free.");
  });

  test("a signed-in visitor is routed on rather than offered a second passkey", async () => {
    setSession(signedIn("brisk-heron"));
    const view = await mountAsync(landing());

    expect(view.find(".notice").textContent).toContain("brisk-heron");
    expect(view.find(".notice a").getAttribute("href")).toBe("/dashboard");
    expect(
      view.all("button").some((n) => n.textContent === "Create an account"),
    ).toBe(false);
  });

  test("both buttons are held while the session is still resolving", () => {
    setSession(PENDING);
    // The first render, before the effect reads the store: on the server the
    // session is always unresolved, which is what makes the two renders match.
    const view = mount(landing());

    expect(
      view
        .all<HTMLButtonElement>(".card-feature button")
        .every((n) => n.disabled),
    ).toBe(true);
  });

  test("registering runs the ceremony and lands on the dashboard", async () => {
    client.passkey.addPasskey = ok({ id: "pk1" });
    const view = await mountAsync(landing());

    await click(view.byText("button", "Create an account"));

    expect(navigations).toEqual(["/dashboard"]);
  });

  test("signing in runs the other ceremony", async () => {
    client.signIn.passkey = ok({ user: { id: "u1" } });
    const view = await mountAsync(landing());

    await click(view.byText("button", "I already have one"));

    expect(navigations).toEqual(["/dashboard"]);
  });

  test("one busy flag and one error line serve the nav and the card alike", async () => {
    const ceremony = deferred<unknown>();
    client.passkey.addPasskey = ceremony.answer;
    const view = await mountAsync(landing());

    view
      .byText("button", "Create an account")
      .dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(
      view.all<HTMLButtonElement>("button").every((node) => node.disabled),
    ).toBe(true);

    ceremony.release({ data: null, error: { message: "cancelled" } });
    await flush();
    expect(view.all(".error").length).toBe(1);
    expect(view.find(".error").textContent).toBe("cancelled");
  });

  test("the curl example uses the origin the server resolved, not the browser's", async () => {
    const view = await mountAsync(landing());

    // Read from `location` instead and the snippet would differ between the
    // server render and the first client render - a hydration mismatch.
    expect(view.find(".snippet code").textContent).toContain(
      `curl -X PUT ${ORIGIN}/api/plans`,
    );
    expect(view.find(".snippet").getAttribute("tabindex")).toBe("0");
    expect(view.find(".snippet").getAttribute("aria-label")).toBe(
      "Example upload command",
    );
  });

  test("the three feature cards are all there", async () => {
    const view = await mountAsync(landing());

    expect(
      view.all(".card-grid .card-title").map((n) => n.textContent),
    ).toEqual([
      "Standalone only",
      "Safe to hand around",
      "Publish from a script",
    ]);
  });
});

describe("the dashboard page", () => {
  test("says nothing while the session is resolving", () => {
    setSession(PENDING);
    const view = mount(dashboard());

    expect(view.find(".muted").textContent).toBe("Loading…");
    expect(navigations).toEqual([]);
  });

  test("a resolved signed-out session is sent to the landing page", async () => {
    setSession(SIGNED_OUT);
    await mountAsync(dashboard());

    expect(navigations).toEqual(["/"]);
  });

  test("a failed session is not a signed-out one", async () => {
    setSession({
      data: null,
      error: { message: "network is down" },
      isPending: false,
    });
    const view = await mountAsync(dashboard());

    // Redirecting on a dropped request would throw a signed-in reader back to
    // the landing page instead of letting them retry.
    expect(navigations).toEqual([]);
    expect(view.find(".error").textContent).toContain(
      "Could not load your session.",
    );
    expect(view.find(".error a").getAttribute("href")).toBe("/dashboard");
  });

  test("a signed-in session gets the panels", async () => {
    quietDashboard();
    setSession(signedIn("brisk-heron"));
    const view = await mountAsync(dashboard());

    expect(view.find(".page-title").textContent).toBe(
      "Your plans, keys, and passkeys.",
    );
    expect(view.all(".card-title").map((n) => n.textContent)).toEqual([
      "Plans",
      "API keys",
      "Passkeys",
      "Delete this account",
    ]);
    expect(navigations).toEqual([]);
  });

  test("the handle is shown as the thing to hand out", async () => {
    quietDashboard();
    setSession(signedIn("brisk-heron"));
    const view = await mountAsync(dashboard());

    expect(view.byText(".lede", "You are").textContent).toContain(
      "brisk-heron",
    );
    // And again in the confirmation the delete control demands.
    expect(view.find("#confirm-handle")).not.toBeNull();
    expect(view.find(".card-dark code").textContent).toBe("brisk-heron");
  });
});

describe("the chrome", () => {
  test("the wordmark goes home from every page", async () => {
    const view = await mountAsync(landing());

    expect(view.find(".wordmark").getAttribute("href")).toBe("/");
  });

  test("a signed-out visitor gets a sign-in button and no handle", async () => {
    const view = await mountAsync(landing());

    expect(view.byText(".nav-right button", "Sign in")).not.toBeNull();
    expect(view.maybe(".nav-handle")).toBeNull();
  });

  test("a signed-in visitor gets the handle, visibly labelled", async () => {
    setSession(signedIn("brisk-heron"));
    const view = await mountAsync(landing());

    // A tooltip is invisible at a glance and absent on touch, and this is the
    // one string another account needs in order to share a plan.
    expect(view.find(".nav-handle-label").textContent).toBe("Handle");
    expect(view.find(".nav-handle").textContent).toBe("Handlebrisk-heron");
  });

  test("the nav offers the dashboard from the landing page", async () => {
    setSession(signedIn());
    const view = await mountAsync(landing());

    expect(view.byText(".nav-right a", "Dashboard").getAttribute("href")).toBe(
      "/dashboard",
    );
  });

  test("and drops that link on the dashboard itself", async () => {
    quietDashboard();
    setSession(signedIn());
    const view = await mountAsync(dashboard());

    expect(
      view.all(".nav-right a").some((n) => n.textContent === "Dashboard"),
    ).toBe(false);
  });

  test("signing out leaves for the home page rather than reloading", async () => {
    client.signOut = ok({ success: true });
    setSession(signedIn());
    const view = await mountAsync(landing());

    await click(view.byText("button", "Sign out"));

    // Signed out, the dashboard guard would only bounce them here anyway.
    expect(navigations).toEqual(["/"]);
  });

  test("a page rendered without an auth context carries no sign-in control", () => {
    // The 404 served from the plan path: a dead button is worse than none.
    const view = mount(<NotFound />);

    expect(view.maybe(".nav-right")).toBeNull();
    expect(view.find(".wordmark")).not.toBeNull();
  });

  test("the footer names the API and the source", async () => {
    const view = await mountAsync(landing());

    expect(view.all(".footer .mono").map((n) => n.textContent)).toEqual([
      "PUT /api/plans",
      "PUT /api/plans/:id",
      "DELETE /api/plans/:id",
      "GET /p/:id",
    ]);
    expect(view.all(".footer a").map((n) => n.getAttribute("href"))).toContain(
      "/api/docs",
    );
  });

  test("every page has a main landmark", async () => {
    const view = await mountAsync(landing());

    expect(view.find("main").id).toBe("main");
  });
});

describe("the 404", () => {
  test("explains the two reasons a plan URL is dead", () => {
    const view = mount(<NotFound />);

    expect(view.find(".page-title").textContent).toBe(
      "Nothing lives at this URL.",
    );
    expect(view.text()).toContain("may have been deleted by its owner");
    // A plan that exists but is not shared says so instead, which is the gate.
    expect(view.text()).toContain("says so instead of showing this page");
    expect(view.find(".lede a").getAttribute("href")).toBe("/");
  });
});

describe("Page routing", () => {
  test("dispatches on the name the server serialised", async () => {
    const view = await mountAsync(
      <Page name="gate" path="/p/abc" origin={ORIGIN} planId="abc" hasCode />,
    );

    expect(view.find(".page-title").textContent).toBe("This plan is private.");
  });

  test("a ceremony failure on the gate reaches its own page", async () => {
    client.signIn.passkey = refuse("no credential was offered");
    const view = await mountAsync(
      <Page
        name="gate"
        path="/p/abc"
        origin={ORIGIN}
        planId="abc"
        hasCode={false}
      />,
    );

    await click(view.byText("button", "Sign in with passkey"));

    expect(view.find('[role="alert"]').textContent).toBe(
      "no credential was offered",
    );
  });
});
