import { API_TITLE } from "./openapi.ts";

/**
 * Where `scripts/vendor-scalar.ts` puts Scalar's browser bundle, relative to
 * `public/` and therefore also the URL it is served at. Its own directory so
 * the copy cannot collide with the content-hashed `entry-*.js` the build
 * writes to the same root.
 */
export const SCALAR_SCRIPT_PATH = "/scalar/standalone.js";

/**
 * `standalone.js` is an IIFE, not a module: it defines `window.Scalar` and
 * nothing else. `createApiReference` is the whole contract this page depends
 * on, and tests/docs-page.test.ts holds the vendored bundle to it.
 */
const CONFIG = {
  /**
   * A URL rather than the document inline, so the browser caches the spec and
   * the page itself stays a few hundred bytes.
   */
  url: "/api/openapi.json",
  /**
   * Scalar's default theme pulls fourteen `@font-face` files from
   * fonts.scalar.com. Nothing else this app serves reaches off-origin, and a
   * self-hosted deployment on a private network would render without them
   * anyway, so the reference uses the system stack instead.
   */
  withDefaultFonts: false,
  /**
   * Scalar's AI chat, which fetches `/vector/registry/curated` and
   * `/vector/registry/search` from api.scalar.com on load - two outbound
   * requests, made before anyone asks for anything, from a page behind the
   * same origin as the dashboard. Off.
   */
  agent: { disabled: true },
};

/**
 * The page at /api/docs: a mount point and the vendored bundle. Everything in
 * it is a compile-time constant, so it is built once rather than per request.
 */
export const DOCS_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${API_TITLE}</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="${SCALAR_SCRIPT_PATH}"></script>
    <script>
      Scalar.createApiReference('#app', ${JSON.stringify(CONFIG)})
    </script>
  </body>
</html>
`;
