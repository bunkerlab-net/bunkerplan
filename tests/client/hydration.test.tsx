import "./dom-env.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { hydrateRoot } from "hono/jsx/dom/client";
import { PAGE_PROPS_ID, ROOT_ID } from "../../src/client/mount.ts";
import { Page, type PageProps } from "../../src/client/pages.tsx";
import type { AssetManifest } from "../../src/server/assets.ts";
import {
  renderDashboard,
  renderLanding,
  renderPlanGate,
} from "../../src/server/pages.tsx";
import { useApiStub } from "./api-stub.ts";
import { navigations, replacements, useAuthStub } from "./auth-stub.ts";
import { flush } from "./harness.tsx";

/**
 * The handshake between the two renders, driven exactly as `entry.tsx` does
 * it: parse the props element out of the server's document, hydrate the same
 * `Page` onto the server's markup.
 *
 * This is the only place a whole class of bug is visible. `hono/jsx/dom` drops
 * an attribute whose value is `false` and writes `""` for `true`, while the
 * server renderer writes `"false"` and `"true"` - so an attribute the server
 * emitted correctly is *deleted* the moment the page hydrates. Neither a
 * server-render test nor a component test can see it, because each only ever
 * looks at one of the two renderers.
 */

const ASSETS: AssetManifest = {
  script: "/assets/entry-deadbeef.js",
  stylesheet: "/assets/entry-cafebabe.css",
};

const ORIGIN = "https://plans.test";

const hosts: HTMLElement[] = [];
const roots: Array<{ unmount: () => void }> = [];

/**
 * Unmounted, not merely detached.
 *
 * `PlansPanel` registers `dragover`/`drop` listeners on `window`, which is one
 * object for the whole process - so a hydrated dashboard that is only removed
 * from the document keeps swallowing file drops in every file that runs after
 * this one. Under `--isolate` that is invisible; in a single process it shows
 * up as a test in another file failing for a reason that is not in it.
 *
 * Registered above the arming calls on purpose: hooks run in registration
 * order, so this has to teardown while the stubs are still standing in. Armed
 * last, disarmed last.
 */
afterEach(async () => {
  try {
    for (const root of roots.splice(0)) root.unmount();
    await flush();
    for (const host of hosts.splice(0)) host.remove();
  } finally {
    // The relay test moves the browser to `/s/{id}`, and the stub captures the
    // forward instead of following it, so nothing else puts this back.
    window.history.replaceState(null, "", "/");
  }
});

useApiStub();
useAuthStub();

/**
 * Runs the server document through the browser's half of the handshake.
 *
 * The markup is installed as it arrived, then hydrated from the props element
 * the same way `entry.tsx` reads it - so what comes back is the DOM a real
 * visitor is left holding.
 *
 * The bundle and stylesheet tags are removed first: happy-dom would try to
 * fetch them off a server that is not running, and what they point at is
 * already held to the build's own manifest by tests/assets.test.ts.
 *
 * Removed by querying the parsed tree rather than by rewriting the text. The
 * regexes this replaced matched on attribute order, so reordering `rel` and
 * `href` in the renderer would have left the tag in and started real fetches
 * without failing anything here.
 */
async function hydrate(document_: string): Promise<HTMLElement> {
  const page = document.createElement("div");
  page.innerHTML = document_.replace("<!doctype html>", "");
  for (const node of page.querySelectorAll(
    'script[type="module"], link[rel="stylesheet"], link[rel="icon"], link[rel="apple-touch-icon"]',
  )) {
    node.remove();
  }
  document.body.appendChild(page);
  hosts.push(page);

  const props = page.querySelector(`#${PAGE_PROPS_ID}`);
  const root = page.querySelector<HTMLElement>(`#${ROOT_ID}`);
  // Named separately: these are two different bugs in the server render, and
  // one message for both sends the next reader looking at the wrong half.
  if (props === null) {
    throw new Error(`the server document carries no #${PAGE_PROPS_ID} element`);
  }
  if (root === null) {
    throw new Error(`the server document carries no #${ROOT_ID} element`);
  }

  roots.push(
    hydrateRoot(
      root,
      <Page {...(JSON.parse(props.textContent ?? "{}") as PageProps)} />,
    ),
  );
  await flush();
  return root;
}

describe("the plan gate", () => {
  test("keeps the share code out of the spell checker", async () => {
    const served = renderPlanGate(ASSETS, "abc123", ORIGIN, { hasCode: true });
    expect(served).toContain('spellcheck="false"');

    const root = await hydrate(served);

    // On several platforms the spell checker ships text to a remote service,
    // and this box holds a bearer secret.
    expect(root.querySelector("input")?.getAttribute("spellcheck")).toBe(
      "false",
    );
  });

  test("keeps autocomplete off", async () => {
    const root = await hydrate(
      renderPlanGate(ASSETS, "abc123", ORIGIN, { hasCode: true }),
    );

    expect(root.querySelector("input")?.getAttribute("autocomplete")).toBe(
      "off",
    );
  });

  test("survives hydration without losing the page", async () => {
    const root = await hydrate(
      renderPlanGate(ASSETS, "abc123", ORIGIN, { hasCode: false }),
    );

    expect(root.textContent).toContain("This plan is private.");
    expect(root.querySelector("input")).toBeNull();
  });

  test("the relay's own prop survives into the hydrated effect", async () => {
    /*
     * The markup is identical either way - the flag only changes what happens
     * after mount - so asserting on the DOM would pass with `relay` deleted.
     * What this pins is the whole path: the server puts the flag in the props
     * element, hydration reads it back, and the effect forwards. A page that
     * hydrated with the flag lost would sit on `/s/{id}` showing a reader a box
     * for a plan they may already be allowed to read.
     */
    window.history.replaceState(null, "", "/s/abc123");

    const root = await hydrate(
      renderPlanGate(ASSETS, "abc123", ORIGIN, { hasCode: true, relay: true }),
    );

    expect(root.querySelector("input")).not.toBeNull();
    expect(replacements).toEqual(["/p/abc123"]);
    // `replace`, not `assign`: the relay must not sit in the back history.
    expect(navigations).toEqual([]);
  });
});

describe("the landing page", () => {
  test("hydrates onto the markup the server sent", async () => {
    const root = await hydrate(renderLanding(ASSETS, "/", ORIGIN));

    expect(root.textContent).toContain(
      "Upload one HTML file. Get a URL that opens.",
    );
    // The origin came through the props element rather than from `location`,
    // which is what keeps the two renders identical.
    expect(root.querySelector(".snippet code")?.textContent).toContain(
      `${ORIGIN}/api/plans`,
    );
  });
});

describe("the dashboard", () => {
  test("hydrates onto the signed-out placeholder the server rendered", async () => {
    const root = await hydrate(renderDashboard(ASSETS, "/dashboard", ORIGIN));

    // Signed out on both sides, so the guard's placeholder is what survives.
    expect(root.textContent).toContain("Loading");
    /*
     * And the same negative the server render is held to: the client's first
     * paint carries no account data either, so hydration cannot be what
     * reveals a handle. The old name here claimed to check the dashboard's
     * disclosure, which this cannot reach - the server only ever renders the
     * signed-out tree, so there is no disclosure in the markup to hydrate.
     */
    expect(root.querySelector(".nav-handle")).toBeNull();
  });
});

/**
 * The general rule, stated once against the renderer rather than against any
 * one page: a boolean-valued attribute does not survive as one, and a
 * string-valued one does. Every ARIA state and enumerated attribute in this
 * app has to be written as a string for that reason, and this is what says
 * why.
 *
 * These record what the pinned hono actually does; they are not a wish. The
 * mismatch below is the bug the string workaround exists for, so asserting
 * that the two renderers agree would fail today and delete the only warning
 * anyone gets if the workaround is dropped. If hono fixes this, these fail -
 * which is the point, and the moment to reconsider the workaround.
 */
describe("attributes across the two renderers", () => {
  test("a false boolean is dropped, and a string is kept", async () => {
    const host = document.createElement("div");
    // Exactly what the server renderer emits for these props.
    host.innerHTML =
      '<input type="text" spellcheck="false" data-kept="false">' +
      '<button type="button" aria-expanded="false">s</button>';
    document.body.appendChild(host);
    hosts.push(host);

    const Box = () => (
      <>
        <input type="text" spellcheck={false} data-kept="false" />
        <button type="button" aria-expanded={false}>
          s
        </button>
      </>
    );
    roots.push(hydrateRoot(host, <Box />));
    await flush();

    // Both were on the server's markup and are now gone.
    expect(host.querySelector("input")?.getAttribute("spellcheck")).toBeNull();
    expect(
      host.querySelector("button")?.getAttribute("aria-expanded"),
    ).toBeNull();
    // Written as a string it stays, which is the workaround both call sites
    // in this app use.
    expect(host.querySelector("input")?.getAttribute("data-kept")).toBe(
      "false",
    );
  });

  test("a true boolean becomes empty, which is not what it rendered as", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<input type="text" spellcheck="true" aria-busy="true">';
    document.body.appendChild(host);
    hosts.push(host);

    const Box = () => <input type="text" spellcheck={true} aria-busy={true} />;
    roots.push(hydrateRoot(host, <Box />));
    await flush();

    /*
     * The other half of the rule, and the worse half. `false` at least
     * disappears visibly; `true` survives as the empty string, so the server's
     * `aria-busy="true"` becomes `aria-busy=""` on hydration - which is not a
     * valid ARIA state value at all, where the boolean it came from was fine.
     */
    const input = host.querySelector("input");
    expect(input?.getAttribute("spellcheck")).toBe("");
    expect(input?.getAttribute("aria-busy")).toBe("");
  });
});
