/**
 * Boots the reference on /api/docs.
 *
 * A served file rather than an inline `<script>`: the app policy is
 * `script-src 'self'` (src/http/security-headers.ts), which refuses inline
 * execution outright. Inlined, this ran nowhere and the page rendered an empty
 * `<div id="app">` - only a browser sees that, so tests/docs-page.test.ts
 * asserts the document carries no inline script at all.
 *
 * `standalone.js` is an IIFE, not a module: it defines `window.Scalar` and
 * nothing else. `createApiReference` is the whole contract this page depends on.
 */
/*
 * Guarded, because the two scripts load independently: if `standalone.js` is
 * missing or was blocked, a bare call here throws a ReferenceError into the
 * console and the page still renders its empty `<div id="app">`. Saying which
 * file did not arrive is the difference between a one-line diagnosis and
 * reading a CSP report.
 */
if (typeof Scalar === "undefined") {
  console.warn(
    "the API reference bundle did not load; /scalar/standalone.js is missing or was blocked",
  );
} else {
  Scalar.createApiReference("#app", {
    /**
     * A URL rather than the document inline, so the browser caches the spec
     * and the page itself stays a few hundred bytes.
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
  });
}
