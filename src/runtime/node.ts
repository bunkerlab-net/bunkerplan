import { createAuth } from "../auth/instance.ts";
import { loadConfig } from "../config.ts";
import { createLogger } from "../log.ts";
import type {
  Db,
  KvStore,
  PlanStorage,
  RuntimeTarget,
  Services,
} from "../services/types.ts";

/**
 * Node/Bun wiring. Structurally matches src/runtime/cloudflare.ts.
 *
 * Every driver is loaded through `await import()` because the module specifier
 * is genuinely runtime-selected by `*_DRIVER`: importing `pg` when the operator
 * chose SQLite, or `bun:sqlite` when running under plain Node, would fail at
 * module scope for a driver that is never used.
 */

export const runtime: RuntimeTarget = "node";

let services: Promise<Services> | undefined;

export function getServices(): Promise<Services> {
  services ??= initialise();
  return services;
}

async function initialise(): Promise<Services> {
  const config = loadConfig(process.env);

  let db: Db;
  if (config.dbDriver === "postgres") {
    const { createPostgresDb } = await import("../db/postgres.ts");
    // loadConfig already rejects a missing DATABASE_URL for this driver; the
    // compiler cannot see that cross-field invariant.
    const connectionString = config.databaseUrl ?? "";
    db = createPostgresDb(connectionString);
  } else if (config.dbDriver === "sqlite") {
    const { createBunSqliteDb } = await import("../db/bun-sqlite.ts");
    db = createBunSqliteDb(config.sqlitePath);
  } else {
    throw new Error(
      `DB_DRIVER=${config.dbDriver} is only available on Cloudflare Workers; ` +
        "use postgres or sqlite when self-hosting",
    );
  }

  let kv: KvStore;
  if (config.kvDriver === "valkey") {
    const { createValkeyKv } = await import("../kv/valkey.ts");
    // loadConfig already rejects a missing VALKEY_URL for this driver.
    kv = createValkeyKv(config.valkeyUrl ?? "");
  } else {
    throw new Error(
      "KV_DRIVER=kv is only available on Cloudflare Workers; use valkey when self-hosting",
    );
  }

  let storage: PlanStorage;
  if (config.storageDriver === "s3") {
    const { createS3Storage } = await import("../storage/s3.ts");
    storage = createS3Storage(config);
  } else {
    throw new Error(
      "STORAGE_DRIVER=r2 is only available on Cloudflare Workers; use s3 when self-hosting",
    );
  }

  const logger = createLogger(config);
  const auth = createAuth({ config, db, kv, storage, logger });
  return { config, auth, logger, storage, kv, db };
}
