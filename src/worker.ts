import { createApp } from "./app.ts";
import { getServices, runtime } from "./runtime/cloudflare.ts";
import { ASSETS } from "./server/manifest.generated.ts";

/**
 * The Cloudflare entry.
 *
 * There is no `#runtime` alias any more: this file names the Workers wiring
 * directly and src/node.ts names the other, so `pg`, `ioredis`, and
 * `bun:sqlite` are unreachable from this module graph by construction rather
 * than by a bundler setting.
 *
 * Static assets never reach here - Cloudflare serves `dist/client` in front of
 * the script, per `assets.directory` in wrangler.jsonc.
 */
const app = createApp({ getServices, runtime, assets: ASSETS });

export default { fetch: app.fetch };
