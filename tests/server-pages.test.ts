import { describe, expect, test } from "bun:test";
import { PAGE_PROPS_ID, ROOT_ID } from "../src/client/mount.ts";
import type { AssetManifest } from "../src/server/assets.ts";
import {
  renderDashboard,
  renderLanding,
  renderNotFound,
  renderPlanGate,
} from "../src/server/pages.tsx";

/**
 * The documents the server sends before any JavaScript has run.
 *
 * Two contracts live here and neither is visible from a component test. The
 * props element is the whole hydration handshake - the client reads it back
 * and renders from it, so if the two disagree the page silently never
 * hydrates. And the social tags have to carry absolute URLs built from the
 * configured origin, because a crawler runs no JavaScript and `Host` is
 * whatever reached the process.
 */

const ASSETS: AssetManifest = {
  script: "/assets/entry-deadbeef.js",
  stylesheet: "/assets/entry-cafebabe.css",
};

const ORIGIN = "https://plans.example.test";

/** What the client will parse back out of the document. */
function pageProps(markup: string): unknown {
  const match = new RegExp(
    `<script type="application/json" id="${PAGE_PROPS_ID}">(.*?)</script>`,
    "s",
  ).exec(markup);
  if (match?.[1] === undefined) {
    throw new Error(`no props element in:\n${markup}`);
  }
  return JSON.parse(match[1].replaceAll("\\u003c", "<"));
}

const metaOf = (markup: string, key: string): string | null => {
  const match = new RegExp(
    `<meta (?:name|property)="${key}" content="([^"]*)"`,
  ).exec(markup);
  return match?.[1] ?? null;
};

describe("every page", () => {
  const pages: ReadonlyArray<[string, string]> = [
    ["landing", renderLanding(ASSETS, "/", ORIGIN)],
    ["dashboard", renderDashboard(ASSETS, "/dashboard", ORIGIN)],
    ["gate", renderPlanGate(ASSETS, "abc123", true, ORIGIN)],
    ["404", renderNotFound(ASSETS)],
  ];

  test.each(pages)("%s is a complete HTML document", (_name, markup) => {
    expect(markup).toStartWith('<!doctype html><html lang="en">');
    expect(markup).toEndWith("</html>");
    expect(markup).toContain('<meta charSet="utf-8"');
    expect(markup).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1"',
    );
    expect(markup).toContain("<title>BunkerPlan</title>");
  });

  test.each(pages)(
    "%s loads the hashed bundle the build emitted",
    (_name, markup) => {
      // A mismatch here serves a dead script: the page renders unstyled and
      // never hydrates, with no error anywhere.
      expect(markup).toContain(
        `<link rel="stylesheet" href="${ASSETS.stylesheet}"`,
      );
      expect(markup).toContain(`<script type="module" src="${ASSETS.script}"`);
    },
  );

  test.each(pages)(
    "%s offers a skip link into the main landmark",
    (_name, markup) => {
      expect(markup).toContain('<a class="skip-link" href="#main">');
      expect(markup).toContain('<main id="main">');
    },
  );

  test.each(pages)("%s carries both favicon formats", (_name, markup) => {
    expect(markup).toContain('href="/favicon.svg" type="image/svg+xml"');
    expect(markup).toContain('href="/favicon-32.png" type="image/png"');
    expect(markup).toContain('rel="apple-touch-icon"');
  });

  test.each(pages)(
    "%s renders into the id the client hydrates",
    (_name, markup) => {
      expect(markup).toContain(`<div id="${ROOT_ID}">`);
    },
  );
});

describe("the landing page", () => {
  const markup = renderLanding(ASSETS, "/", ORIGIN);

  test("hands the client the props it renders from", () => {
    expect(pageProps(markup)).toEqual({
      name: "landing",
      path: "/",
      origin: ORIGIN,
    });
  });

  test("is rendered signed-out, which is what the client's first render matches", () => {
    // The server cannot know the session, so the markup must be the one a
    // resolving session produces - otherwise hydration mismatches.
    expect(markup).toContain("Create an account");
    expect(markup).not.toContain("nav-handle");
  });

  test("shows the configured origin in the upload example", () => {
    expect(markup).toContain(`curl -X PUT ${ORIGIN}/api/plans`);
  });

  test("carries social tags with absolute URLs", () => {
    expect(metaOf(markup, "og:url")).toBe(`${ORIGIN}/`);
    expect(metaOf(markup, "og:image")).toBe(`${ORIGIN}/og-v2.png`);
    expect(metaOf(markup, "twitter:image")).toBe(`${ORIGIN}/og-v2.png`);
    expect(metaOf(markup, "og:type")).toBe("website");
    expect(metaOf(markup, "twitter:card")).toBe("summary_large_image");
    expect(metaOf(markup, "og:image:width")).toBe("1200");
    expect(metaOf(markup, "og:image:height")).toBe("630");
    expect(metaOf(markup, "og:image:alt")).not.toBeNull();
    expect(metaOf(markup, "description")).not.toBeNull();
  });

  test("the origin comes from configuration, not from the request", () => {
    // `Host` is whatever reached the process; behind a proxy that forwards it
    // unchanged a crawler could be handed tags pointing at another hostname.
    const elsewhere = renderLanding(ASSETS, "/", "https://mirror.example");
    expect(metaOf(elsewhere, "og:url")).toBe("https://mirror.example/");
  });

  test("a non-root path is still resolved against the origin", () => {
    const nested = renderLanding(ASSETS, "/somewhere", ORIGIN);
    expect(metaOf(nested, "og:url")).toBe(`${ORIGIN}/somewhere`);
  });
});

describe("the dashboard page", () => {
  const markup = renderDashboard(ASSETS, "/dashboard", ORIGIN);

  test("hands the client its own props", () => {
    expect(pageProps(markup)).toEqual({
      name: "dashboard",
      path: "/dashboard",
      origin: ORIGIN,
    });
  });

  test("carries social tags, and nothing account-specific in them", () => {
    // Unlike the gate, this page is not marked noindex - and it discloses
    // nothing by being crawled: the tags are the site's own, and the server
    // render below has no account data in it at all.
    expect(metaOf(markup, "og:url")).toBe(`${ORIGIN}/dashboard`);
    expect(metaOf(markup, "og:title")).toBe("BunkerPlan");
    expect(metaOf(markup, "robots")).toBeNull();
  });

  test("renders no account data, because the server has none", () => {
    expect(markup).not.toContain("nav-handle");
    expect(markup).toContain("Loading");
  });
});

describe("the plan gate", () => {
  test("carries the plan id and whether there is a code to enter", () => {
    const markup = renderPlanGate(ASSETS, "abc123", true, ORIGIN);

    expect(pageProps(markup)).toEqual({
      name: "gate",
      planId: "abc123",
      hasCode: true,
      path: "/p/abc123",
      origin: ORIGIN,
    });
    expect(markup).toContain("Have a code?");
  });

  test("a plan with no code offers no code box", () => {
    const markup = renderPlanGate(ASSETS, "abc123", false, ORIGIN);

    expect(pageProps(markup)).toMatchObject({ hasCode: false });
    expect(markup).not.toContain("Have a code?");
  });

  test("is not indexed - it names a private plan", () => {
    const markup = renderPlanGate(ASSETS, "abc123", true, ORIGIN);

    expect(metaOf(markup, "robots")).toBe("noindex");
    expect(metaOf(markup, "og:url")).toBeNull();
  });

  test("reveals nothing about the document behind it", () => {
    const markup = renderPlanGate(ASSETS, "abc123", true, ORIGIN);

    expect(markup).toContain("This plan is private.");
    expect(markup).toContain(
      "Nothing about the document itself is revealed here.",
    );
  });

  test("a payload that would close the script early is escaped", () => {
    // `</script>` is the break-out: an HTML parser ends a script element at
    // the first one, whatever the JSON around it says. Today's plan ids are
    // validated to lowercase alphanumerics and nothing can carry this, but the
    // serialiser is shared, so the boundary is pinned rather than argued about.
    const payload = "</script><script>alert(1)</script>";
    const markup = renderPlanGate(ASSETS, payload, true, ORIGIN);

    const element = new RegExp(
      `id="${PAGE_PROPS_ID}">(.*?)</script>`,
      "s",
    ).exec(markup)?.[1];
    expect(element).toBeDefined();
    // The element ran to its own closing tag and not to a smuggled one.
    expect(element).not.toContain("</script");
    expect(element).not.toContain("alert(1)</");
    // `<` alone is escaped, which is enough: `\u003c/script>` cannot end the
    // element, and `>` on its own is inert.
    expect(element).toContain("\\u003c/script>");
    // And it still parses back to exactly what went in.
    expect(pageProps(markup)).toMatchObject({ planId: payload });
    // Only one script of this kind exists in the document.
    expect(markup.split(`id="${PAGE_PROPS_ID}"`).length).toBe(2);
  });

  test("the props element parses as the JSON the client expects", () => {
    const markup = renderPlanGate(ASSETS, "abc123", true, ORIGIN);

    expect(markup).toContain(
      `<script type="application/json" id="${PAGE_PROPS_ID}">`,
    );
  });
});

describe("the 404", () => {
  const markup = renderNotFound(ASSETS);

  test("carries no props, so the client leaves it alone", () => {
    // It is what `/p/{unknown}` falls through to, where there is no session to
    // resolve and nothing on the page to interact with.
    expect(markup).not.toContain(`id="${PAGE_PROPS_ID}"`);
  });

  test("is not indexed", () => {
    expect(metaOf(markup, "robots")).toBe("noindex");
  });

  test("says what happened and offers a way out", () => {
    expect(markup).toContain("Nothing lives at this URL.");
    expect(markup).toContain('href="/"');
  });

  test("carries no sign-in control, because it is served without an auth context", () => {
    expect(markup).not.toContain("nav-right");
  });
});
