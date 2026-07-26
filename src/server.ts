import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { applySecurityHeaders } from "./http/security-headers.ts";

export default createServerEntry({
  fetch: async (request) =>
    applySecurityHeaders(request, await handler.fetch(request)),
});
