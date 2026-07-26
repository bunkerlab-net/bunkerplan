import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { getServices } from "#runtime";
import { applySecurityHeaders } from "./http/security-headers.ts";

export default createServerEntry({
  fetch: async (request) => {
    // Resolved here so configuration is loaded before anything renders. Server
    // rendering reads the canonical origin synchronously, and a route that
    // never touches the services would otherwise reach `head()` first and fall
    // back to the request's own `Host`. Memoised, so this costs one await.
    await getServices();
    return applySecurityHeaders(request, await handler.fetch(request));
  },
});
