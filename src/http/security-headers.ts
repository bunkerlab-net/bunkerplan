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
 * It deliberately omits `script-src`: the rendered document carries an inline
 * `<script type="application/json">` with the page props the client hydrates
 * from, so a script policy needs per-request nonces.
 *
 * Exported beside `PLAN_CSP` so a test can assert the policy itself rather
 * than that some policy is present, which a weakened one would satisfy.
 */
export const APP_CSP =
  "base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'";

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
