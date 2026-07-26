/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { NotFound } from "../client/NotFound.tsx";
import { publicOrigin } from "../config.ts";
import appCss from "../styles.css?url";

const TITLE = "BunkerPlan";
const DESCRIPTION =
  "Share the plans, reviews, and diagrams your LLM renders in HTML as a link that opens, not a file that downloads.";
/** Crawlers cache by URL, so the filename is bumped when the artwork changes. */
const OG_IMAGE = "/og-v2.png";
const IMAGE_ALT = "BunkerPlan - upload one HTML file, get a URL that opens.";

/**
 * Open Graph requires absolute URLs and crawlers do not run JavaScript, so the
 * origin has to be resolved while rendering on the server rather than read
 * from `window`. `createIsomorphicFn` is what keeps `getRequestUrl` - and the
 * `node:async_hooks` it stands on - out of the client bundle.
 *
 * The origin comes from the configured public base URL, not from the request:
 * `Host` is whatever reached the process, so behind a proxy that forwards it
 * unchanged a crawler could be handed tags pointing at someone else's
 * hostname. Only the path is taken from the request. The client branch can
 * use `location` safely - a browser knows its own origin.
 */
const currentUrl = createIsomorphicFn()
  .server(() => {
    const requested = getRequestUrl();
    const canonical = publicOrigin();
    return canonical === undefined || canonical === ""
      ? requested.href
      : new URL(requested.pathname + requested.search, canonical).href;
  })
  .client(() => window.location.href);

export const Route = createRootRoute({
  head: () => {
    const url = new URL(currentUrl());
    const image = new URL(OG_IMAGE, url).href;
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: TITLE },
        { name: "description", content: DESCRIPTION },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: TITLE },
        { property: "og:title", content: TITLE },
        { property: "og:description", content: DESCRIPTION },
        { property: "og:url", content: url.href },
        { property: "og:image", content: image },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { property: "og:image:alt", content: IMAGE_ALT },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: TITLE },
        { name: "twitter:description", content: DESCRIPTION },
        { name: "twitter:image", content: image },
        { name: "twitter:image:alt", content: IMAGE_ALT },
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        // SVG first: browsers that understand it get a mark that stays sharp
        // at any tab density; the PNG is the fallback for those that do not.
        { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
        {
          rel: "icon",
          href: "/favicon-32.png",
          type: "image/png",
          sizes: "32x32",
        },
        { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      ],
    };
  },
  component: RootDocument,
  notFoundComponent: NotFound,
});

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
