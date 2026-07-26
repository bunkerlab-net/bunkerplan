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
import appCss from "../styles.css?url";

const TITLE = "BunkerPlan";
const DESCRIPTION =
  "Standalone HTML documents at short public URLs. Passkeys only.";
const IMAGE_ALT = "BunkerPlan - one HTML file in, one public URL out.";

/**
 * Open Graph requires absolute URLs and crawlers do not run JavaScript, so the
 * origin has to be resolved while rendering on the server rather than read from
 * `window`. `createIsomorphicFn` is what keeps `getRequestUrl` - and the
 * `node:async_hooks` it stands on - out of the client bundle.
 *
 * Taken from the request rather than PUBLIC_BASE_URL so the tags stay correct
 * on whatever host actually served the page.
 */
const currentUrl = createIsomorphicFn()
  .server(() => getRequestUrl().href)
  .client(() => window.location.href);

export const Route = createRootRoute({
  head: () => {
    const url = new URL(currentUrl());
    const image = new URL("/og.png", url).href;
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
