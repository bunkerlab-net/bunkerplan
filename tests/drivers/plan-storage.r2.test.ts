import { r2Storage } from "./backends.ts";
import { describePlanStorage } from "./contract/plan-storage.ts";

/**
 * One backend per file. Under `bun run test` that is `--isolate`, which gives
 * each file its own module registry and a fresh set of globals, and clears the
 * runtime work still outstanding between files - all inside one shared
 * process. So what the split buys is that the two storage backends cannot
 * reach each other's modules. That much is how every driver file here is
 * organised.
 *
 * The split was originally made under `--parallel`, on a hypothesis that
 * holding a Miniflare workerd child open alongside the AWS SDK could wedge a
 * concurrent S3 request. That was never verified and is not evidence for
 * anything now; see the flake note in README.md, which records what has
 * actually been measured.
 */
describePlanStorage("R2 (Miniflare)", r2Storage, { skip: false });
