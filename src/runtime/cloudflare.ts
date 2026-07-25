import { env } from "cloudflare:workers";
import { createAuth } from "../auth/instance.ts";
import { loadConfig } from "../config.ts";
import { createD1Db } from "../db/d1.ts";
import { createWorkersKv } from "../kv/workers-kv.ts";
import { createLogger } from "../log.ts";
import type { RuntimeTarget, Services } from "../services/types.ts";
import { createR2Storage } from "../storage/r2.ts";

/**
 * Cloudflare Workers wiring. This module is the type-level source of truth for
 * the `#runtime` alias; src/runtime/node.ts must match it structurally.
 *
 * NOTHING reachable from here may import `pg`, `ioredis` or `bun:sqlite` — the
 * Workers bundle would fail to resolve them.
 *
 * Binding types come from the generated `Cloudflare.Env` in
 * worker-configuration.d.ts. Re-run `bun run cf-typegen` after editing
 * wrangler.jsonc; never hand-write the binding interface, or it drifts from the
 * bindings that actually exist.
 */

export const runtime: RuntimeTarget = "cloudflare";

let services: Promise<Services> | undefined;

export function getServices(): Promise<Services> {
  services ??= initialise();
  return services;
}

async function initialise(): Promise<Services> {
  // `env` carries the bindings alongside string vars and secrets. Only the
  // string-valued members are configuration; loadConfig ignores the rest.
  const settings: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") settings[key] = value;
  }
  const config = loadConfig(settings, { workers: true });

  const logger = createLogger(config);
  const db = createD1Db(env.DB);
  const kv = createWorkersKv(env.KV);
  const storage = createR2Storage(env.BUCKET);
  const auth = createAuth({ config, db, kv, storage, logger });

  return await Promise.resolve({ config, auth, logger, storage, kv, db });
}
