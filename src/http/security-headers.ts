/**
 * The one choke point both runtimes share for response security headers.
 *
 * Helmet is not usable here: it is Express/Connect middleware over a Node
 * `ServerResponse`, and the primary target is Cloudflare Workers, which only
 * has Web `Request`/`Response`. This module is the equivalent set that
 * matters, and it is a plain function so the policy can be tested directly
 * rather than only through a built Worker.
 */

/**
 * The policy for an uploaded plan, and the single most important control in
 * this design.
 *
 * What it protects: the uploader's account. `sandbox` without
 * `allow-same-origin` puts the document in an opaque origin, so it is not
 * same-origin with the app it shares a hostname with and cannot touch the
 * session cookie, storage, or `/api/*`. `allow-scripts`, `allow-forms`, and
 * `allow-popups` give back ordinary document behaviour without giving that
 * back.
 *
 * What the `-src` directives add: a plan loads nothing. The upload-time HTML
 * check cannot promise that on its own - it permits inline `<script>` by
 * design, and CSS identifier escapes such as `u\72l(...)` parse as `url(...)`
 * in a browser while defeating any token scan. So the static check is a
 * helpful upload-time error and this header is the boundary.
 *
 * What NOTHING here does, stated plainly so it is not mistaken for more: stop
 * a plan causing an outbound request by NAVIGATING. `connect-src 'none'`
 * covers `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and
 * `sendBeacon`, and `default-src 'none'` covers every subresource - but CSP
 * has no deployable `navigate-to`, and the top-navigation sandbox tokens only
 * govern embedded documents, so a plan served at the top level can assign
 * `location` or call `window.open` and disclose its reader's IP either way.
 * The enforced invariant is "a plan fetches nothing", NOT "a plan cannot
 * reach the network". Only removing `allow-scripts` would close that, and
 * that would stop plans being interactive documents at all.
 *
 * `data:` and `blob:` are allowed for rendering because that is how a
 * standalone document carries its own images, fonts, and media - the bytes
 * travel inside the document, which is exactly the invariant being enforced.
 */
export const PLAN_CSP = [
  "sandbox allow-scripts allow-forms allow-popups",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "frame-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Plans are the only untrusted HTML this app serves, and only from here. */
export const PLAN_PATH_PREFIX = "/p/";

/**
 * The app's own policy.
 *
 * The premise that kept `script-src` off this list was wrong: the inline
 * `<script type="application/json">` carrying the page props is a data block,
 * not an executable one, so the HTML parser never prepares it as script and
 * `script-src` never applies to it. The only executable script on the page is
 * the module bundle at `assets.script`, which is same-origin - no nonce is
 * needed to pin it, and without the directive any injected `<script src>`
 * could name any host it liked.
 *
 * `default-src 'self'` rather than `'none'` so a resource type nobody listed
 * here degrades to same-origin instead of vanishing. `style-src` carries
 * `'unsafe-inline'` because the components use `style={{ ... }}` attributes,
 * which CSP counts as inline styles; removing them is a refactor, not a header
 * change. Fonts are the system stack and src/styles.css loads nothing, so
 * `default-src` covers the rest.
 *
 * Exported beside `PLAN_CSP` so the tests can name which of the two applies to
 * a response.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  /*
   * `'self'` only - no `data:`, no `blob:`, unlike PLAN_CSP which has to take
   * whatever an uploaded document carries. Measured rather than assumed: the
   * Scalar reference at /api/docs renders with zero CSP violations, zero
   * blocked requests and no `<img>` element at all, and the app's own pages
   * serve their icons from `public/`. Widening this needs a blocked resource
   * to point at.
   */
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Framing the dashboard is a route to phishing a passkey ceremony or a
  // freshly minted API key.
  "x-frame-options": "DENY",
  "content-security-policy": APP_CSP,
};

const HSTS = "max-age=31536000; includeSubDomains";

/**
 * Applies the app header set to a response, and pins the plan policy on any
 * response that carries a plan.
 *
 * The plan branch overwrites rather than fills in, and that direction is the
 * whole point. Filling in only when absent is what let a `304` - which
 * legitimately carries almost no headers - inherit the app policy, whose lack
 * of `sandbox` reads as permission to script the real origin; skipping the
 * backfill instead would leave a plan with no policy at all, which is the same
 * failure by another route. Overwriting from one shared constant means the
 * route and this function cannot disagree, and a plan response that forgets
 * the header still cannot reach a client without it.
 *
 * Matched on status as well as path because `/p/{unknown}` falls through to
 * the app's own 404 page, which is trusted HTML and needs the app policy.
 */
export function applySecurityHeaders(
  request: Request,
  response: Response,
): Response {
  const url = new URL(request.url);
  const carriesPlan =
    url.pathname.startsWith(PLAN_PATH_PREFIX) &&
    (response.status === 200 || response.status === 304);

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (carriesPlan) headers.set("content-security-policy", PLAN_CSP);

  // Only over TLS: sending HSTS from a plaintext origin is ignored by
  // browsers, and pinning localhost to https would break development.
  if (url.protocol === "https:" && !headers.has("strict-transport-security")) {
    headers.set("strict-transport-security", HSTS);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
