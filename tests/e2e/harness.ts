import { readdirSync, readFileSync } from "node:fs";
import { defaultKeyHasher } from "@better-auth/api-key";
import { createTestHarness, type TestHarness } from "wrangler";

/**
 * The real Worker on the real local stack: workerd via Miniflare, with D1, R2,
 * and KV behind the same bindings production uses. Nothing below is a fake, so
 * these tests fail on anything the unit suites cannot see - a migration that
 * never ran, SQL that only one dialect accepts, a route that is not wired up.
 *
 * The one thing that is seeded rather than performed is the credential. Signing
 * up means a WebAuthn ceremony, which needs an authenticator; instead a user row
 * and an API key row go straight into D1, and the key is hashed with the api-key
 * plugin's own `defaultKeyHasher` so Better Auth verifies it the ordinary way.
 * If that hashing ever changes, every request here 401s - loudly, not silently.
 *
 * An API key authorises writes only, so session-only reads (`GET /api/plans`)
 * are not reachable from here and row assertions go through `db` instead.
 */

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

/** Low enough that a test can exhaust it, high enough for the others. */
export const UPLOAD_RATE_MAX = 5;
export const UPLOAD_RATE_WINDOW_SEC = 60;

/** Below `UPLOAD_RATE_MAX`, so the quota is what refuses and not the limiter. */
export const MAX_PLANS_PER_USER = 3;

export const PUBLIC_BASE_URL = "http://localhost";

/**
 * The dispatch signature is taken from the harness rather than restated: the
 * ambient `RequestInit`/`Response` here are the Workers ones, which are not
 * the types Miniflare dispatches with.
 */
type Dispatch = TestHarness["fetch"];
export type FetchInit = Parameters<Dispatch>[1];
export type FetchResponse = Awaited<ReturnType<Dispatch>>;

export interface Harness {
  /** Paths resolve against the worker's own origin. */
  fetch(path: string, init?: FetchInit): Promise<FetchResponse>;
  db: D1Database;
  /** The plan bucket, for asserting object layout directly. */
  bucket: R2Bucket;
  /** Seeds a fresh account and returns its API key. */
  account(): Promise<string>;
  close(): Promise<void>;
}

/**
 * `scripts/build.ts` has to run first: it writes the hashed client bundle and
 * src/server/manifest.generated.ts, which src/worker.ts imports. Wrangler
 * bundles the Worker itself from there, so there is no separate server build
 * to wait for.
 *
 * Unconditional rather than mtime-guessed: a stale `dist` would test the
 * previous commit.
 */
async function build(): Promise<void> {
  const result = Bun.spawnSync(["bun", "run", "build"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`build failed:\n${result.stderr.toString()}`);
  }
}

async function migrate(db: D1Database): Promise<void> {
  const dir = `${ROOT}/drizzle/sqlite`;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const statements = readFileSync(`${dir}/${file}`, "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
}

export async function startWorker(): Promise<Harness> {
  await build();

  const server = createTestHarness({
    root: ROOT,
    workers: [
      {
        configPath: `${ROOT}/wrangler.jsonc`,
        vars: {
          PUBLIC_BASE_URL,
          RP_ID: "localhost",
          UPLOAD_RATE_MAX,
          UPLOAD_RATE_WINDOW_SEC,
          MAX_PLANS_PER_USER,
        },
        secrets: {
          // Not a real secret, and never used against real data: this stack is
          // an empty D1 file that the harness throws away.
          BETTER_AUTH_SECRET: "e2e-0123456789abcdef0123456789abcdef",
        },
      },
    ],
  });

  await server.listen();
  const worker = server.getWorker<Env>();
  const { DB, BUCKET } = await worker.getEnv();
  await migrate(DB);

  let seeded = 0;

  return {
    fetch: (path, init) => worker.fetch(path, init),
    db: DB,
    bucket: BUCKET,
    async account() {
      seeded += 1;
      const userId = `e2e-user-${seeded}`;
      const now = Date.now();
      const key = `bkp_${userId}_${crypto.randomUUID()}`;

      await DB.prepare(
        `insert into user (id, name, email, email_verified, created_at, updated_at)
         values (?1, ?1, ?2, 0, ?3, ?3)`,
      )
        .bind(userId, `${userId}@example.test`, now)
        .run();

      // `rate_limit_enabled` off to match the plugin configuration in
      // src/auth/options.ts; its default of 10 requests a day would refuse
      // uploads long before the app's own limit did.
      await DB.prepare(
        `insert into apikey
           (id, config_id, name, prefix, reference_id, key, enabled,
            rate_limit_enabled, request_count, created_at, updated_at)
         values (?1, 'default', ?2, 'bkp_', ?3, ?4, 1, 0, 0, ?5, ?5)`,
      )
        .bind(
          crypto.randomUUID(),
          `${userId} key`,
          userId,
          await defaultKeyHasher(key),
          now,
        )
        .run();

      return key;
    },
    close: () => server.close(),
  };
}

/** A minimal document the standalone validator accepts. */
export function html(body: string): string {
  return `<!doctype html><html><head><title>e2e</title></head><body><p>${body}</p></body></html>`;
}

export function upload(key: string, body: string): FetchInit {
  return {
    method: "PUT",
    headers: { "x-api-key": key, "content-type": "text/html" },
    body,
  };
}
