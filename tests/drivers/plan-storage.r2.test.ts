import { r2Storage } from "./backends.ts";
import { describePlanStorage } from "./contract/plan-storage.ts";

/**
 * Its own file because Miniflare runs a workerd child process, and holding one
 * open in the same test process as the AWS SDK intermittently wedges a
 * concurrent S3 request that then never settles - no socket, so no SDK timeout
 * fires either.
 *
 * A file is no longer a process, though: `bun run test` is `--isolate`, which
 * gives each file its own module registry inside one shared process. So this
 * separation keeps the two backends out of each other's modules, and nothing
 * more.
 */
describePlanStorage("R2 (Miniflare)", r2Storage, { skip: false });
