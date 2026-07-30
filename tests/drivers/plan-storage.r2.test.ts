import { r2Storage } from "./backends.ts";
import { describePlanStorage } from "./contract/plan-storage.ts";

/**
 * One backend per file. Under `bun run test` that is `--isolate`, which gives
 * each file its own module registry inside one shared process - so what this
 * buys is that the two storage backends cannot reach each other's modules, and
 * nothing more.
 *
 * It bought process separation under the `--parallel` runs this file was split
 * for, when holding a Miniflare workerd child open alongside the AWS SDK could
 * wedge a concurrent S3 request that then never settled. Whether that is still
 * reachable in one shared process is untested either way; the split is kept
 * because one backend per file is how every driver file here is organised.
 */
describePlanStorage("R2 (Miniflare)", r2Storage, { skip: false });
