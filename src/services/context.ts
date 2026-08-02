import type { AppAuth } from "../auth/instance.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import type { Db, KvStore, PlanStorage } from "./types.ts";

/**
 * What a runtime module assembles and every route reads.
 *
 * Its own module rather than part of ./types.ts because `auth: AppAuth` pulls
 * in src/auth/instance.ts, and the driver contracts in ./types.ts are what
 * instance.ts itself builds against - keeping `Services` there was the one
 * import cycle in the codebase. Here the graph is a line: context -> auth ->
 * types -> limits.
 */
export interface Services {
  config: Config;
  auth: AppAuth;
  logger: Logger;
  storage: PlanStorage;
  kv: KvStore;
  db: Db;
}
