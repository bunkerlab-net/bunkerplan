import { createFileRoute, notFound } from "@tanstack/react-router";
import { getServices } from "#runtime";
import { NotFound } from "../client/NotFound.tsx";
import { PLAN_CSP } from "../http/security-headers.ts";
import { isPlanId } from "../ids.ts";

/**
 * `PLAN_CSP` is the single most important control in this design and MUST NOT
 * be removed. It lives in `src/http/security-headers.ts` because the entry
 * wrapper pins the same constant onto every plan response, so a slip here
 * cannot reach a client - see the note there.
 */

// Short max-age rather than `immutable` because plans can be deleted, and
// replaced: a cache that already has one can serve the old document until the
// window is up.
const CACHE_CONTROL = "public, max-age=300, must-revalidate";

export const Route = createFileRoute("/p/$planId")({
  server: {
    handlers: {
      GET: async ({ request, params, next }) => {
        // Only ids this app could have issued are routable. Anything else
        // takes the same path as a plan that is not there, so an id that was
        // never valid is indistinguishable from one that has been deleted.
        if (!isPlanId(params.planId)) return next();

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

        // One header set for both branches. A 304 that omitted these would
        // not merely lose them: `src/server.ts` fills in any security header a
        // response leaves absent, so the plan would inherit the *app* policy,
        // which has no `sandbox`. A cache told to update a stored response
        // with the 304's headers (RFC 9111 4.3.4) would then hold the plan
        // under a policy that lets it script the real origin.
        const headers: Record<string, string> = {
          "content-security-policy": PLAN_CSP,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "cache-control": CACHE_CONTROL,
          etag: object.etag,
        };

        if (request.headers.get("if-none-match") === object.etag) {
          return new Response(null, { status: 304, headers });
        }

        return new Response(object.body, {
          status: 200,
          headers: { ...headers, "content-type": "text/html; charset=utf-8" },
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
