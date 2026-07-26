import { createFileRoute } from "@tanstack/react-router";
import { getServices } from "#runtime";

/**
 * Better Auth owns every route under /api/auth/*. `auth.handler` returns a
 * Response carrying any Set-Cookie, which is why `tanstackStartCookies()` is
 * not needed - no cookie-setting `auth.api.*` call is made from a server fn.
 */
async function handle(request: Request): Promise<Response> {
  const { auth } = await getServices();
  return await auth.handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
