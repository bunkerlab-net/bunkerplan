import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

/**
 * App-wide security headers.
 *
 * Helmet is not usable here: it is Express/Connect middleware over a Node
 * `ServerResponse`, and the primary target is Cloudflare Workers, which only
 * has Web `Request`/`Response`. This is the equivalent set that matters,
 * applied at the one choke point both targets share.
 *
 * The CSP here deliberately omits `default-src`/`script-src`: TanStack Start
 * inlines the hydration payload as a `<script>`, so a script policy needs
 * per-request nonces. A policy with `'unsafe-inline'` would be security
 * theatre, so the directives below are limited to the ones that harden real
 * attack surface without touching scripts.
 *
 * `/p/{planId}` sets its own `Content-Security-Policy: sandbox` — the control
 * that stops an uploaded plan acting on its uploader's session. Every header
 * below is only applied when absent, so that route's deliberate values win.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Framing the dashboard is a route to phishing a passkey ceremony or a
  // freshly minted API key.
  "x-frame-options": "DENY",
  "content-security-policy":
    "base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
};

const HSTS = "max-age=31536000; includeSubDomains";

export default createServerEntry({
  fetch: async (request) => {
    const response = await handler.fetch(request);

    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    // Only over TLS: sending HSTS from a plaintext origin is ignored by
    // browsers, and pinning localhost to https would break development.
    if (
      new URL(request.url).protocol === "https:" &&
      !headers.has("strict-transport-security")
    ) {
      headers.set("strict-transport-security", HSTS);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
});
