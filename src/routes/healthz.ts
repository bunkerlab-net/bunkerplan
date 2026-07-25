import { createFileRoute } from "@tanstack/react-router";
import { getServices, runtime } from "#runtime";
import { healthz } from "../http/healthz.ts";

export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      // `getServices` is passed uncalled on purpose: on Workers the probe is
      // refused before any binding is touched. See src/http/healthz.ts.
      GET: () => healthz(runtime, getServices),
    },
  },
});
