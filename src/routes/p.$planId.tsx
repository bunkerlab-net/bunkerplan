import { createFileRoute, notFound } from "@tanstack/react-router";
import { getServices } from "#runtime";
import { NotFound } from "../client/NotFound.tsx";

/**
 * The `Content-Security-Policy: sandbox` header below is the single most
 * important control in this design and MUST NOT be removed.
 *
 * Plans are untrusted HTML served from the same origin as the session cookie.
 * Without it, a plan's inline script could issue credentialed same-origin
 * requests to /api/* and take over the uploader's account. `sandbox` without
 * `allow-same-origin` puts the document in an opaque origin, so it is not
 * same-origin with the app and cannot read cookies or storage; `allow-scripts`,
 * `allow-forms`, and `allow-popups` restore ordinary document behaviour without
 * giving that back.
 */
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups";

// Short max-age rather than `immutable` because plans can be deleted.
const CACHE_CONTROL = "public, max-age=300, must-revalidate";

export const Route = createFileRoute("/p/$planId")({
  server: {
    handlers: {
      GET: async ({ request, params, next }) => {
        // No auth, no database read: serving a plan is a single object read.
        const { storage } = await getServices();
        const object = await storage.get(params.planId);
        if (object === null) {
          // Hand the request to the app router, which renders the site's own
          // 404 page and sets the status - the same path an unknown app route
          // takes. `next` is only a real function because this route declares
          // a `component`; without one, Start demands a Response here.
          return next();
        }

        if (request.headers.get("if-none-match") === object.etag) {
          return new Response(null, {
            status: 304,
            headers: { etag: object.etag, "cache-control": CACHE_CONTROL },
          });
        }

        return new Response(object.body, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": SANDBOX,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "cache-control": CACHE_CONTROL,
            etag: object.etag,
          },
        });
      },
    },
  },
  /**
   * Reached only when the handler above deferred, which it does only for a
   * plan that is not in storage: a found plan returns its own Response and
   * short-circuits the chain before SSR, so this route's untrusted HTML never
   * passes through React. Raising `notFound` here is what puts the `404` on
   * the response, and routes the render through the same
   * `notFoundComponent` an unknown app route gets.
   */
  loader: () => {
    throw notFound();
  },
  /** Declared so `next()` above may defer; the loader pre-empts it. */
  component: NotFound,
});
