import { API_TITLE } from "./openapi.ts";

/**
 * Where `scripts/vendor-scalar.ts` puts Scalar's browser bundle, relative to
 * `public/` and therefore also the URL it is served at. Its own directory so
 * the copy cannot collide with the content-hashed `entry-*.js` the build
 * writes to the same root.
 */
export const SCALAR_SCRIPT_PATH = "/scalar/standalone.js";

/**
 * The bootstrap that calls into that bundle, served rather than inlined.
 *
 * The app policy is `script-src 'self'`, which refuses an inline `<script>`
 * outright - so the call that mounts the reference has to arrive as a file.
 * `public/api-docs.js` holds it, along with the options and why they are set.
 */
export const DOCS_BOOT_PATH = "/api-docs.js";

/**
 * The page at /api/docs: a mount point and two served scripts. Everything in it
 * is a compile-time constant, so it is built once rather than per request.
 *
 * No inline script, and nothing here should add one: it would be refused by the
 * policy and the page would render blank, which no server-side test can see.
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
    <script src="${DOCS_BOOT_PATH}"></script>
  </body>
</html>
`;
