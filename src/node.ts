import { serveStatic } from "hono/bun";
import { createApp } from "./app.ts";
import { getServices, runtime } from "./runtime/node.ts";
import { ASSETS, CLIENT_DIR } from "./server/manifest.generated.ts";

/**
 * The self-hosted entry, run by Bun.
 *
 * Unlike Workers there is no asset layer in front of the process, so the
 * bundled client and everything from `public/` are served from here. It is
 * registered after the routes, so a real route always wins and only an
 * unmatched path reaches the filesystem.
 */
const app = createApp({ getServices, runtime, assets: ASSETS });

app.use("*", serveStatic({ root: CLIENT_DIR }));

export default {
  port: Number(process.env["PORT"] ?? 3000),
  fetch: app.fetch,
};
