import { workersKv } from "./backends.ts";
import { describeKvStore } from "./contract/kv-store.ts";

/** One backend per file, so each gets its own process under `--parallel`. */
describeKvStore("Workers KV (Miniflare)", workersKv, { skip: false });
