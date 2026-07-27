/**
 * Live backends for the driver conformance suites.
 *
 * Six stores ship: D1, R2, and Workers KV on Cloudflare; Postgres, MinIO/S3,
 * and Valkey when self-hosted. Every one of them is reached here through the
 * same driver the application uses, against a real server - Miniflare's
 * workerd for the Cloudflare three, containers for the rest. Nothing below
 * fakes a store, because the bugs these suites exist to catch are precisely
 * the ones a fake cannot have: a dialect that rejects the SQL, a key that
 * escapes its prefix, an empty string that comes back as a miss.
 *
 * Container-backed backends are opt-in by environment variable and SKIP when
 * it is absent, so a checkout with no Docker still runs the Cloudflare half.
 * Once a variable is set the backend must work: an unreachable server fails
 * the suite rather than quietly reporting success against nothing.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.test.yml \
 *     up -d --wait postgres valkey minio
 *   TEST_DATABASE_URL=postgres://bunkerplan:bunkerplan@127.0.0.1:5432/bunkerplan \
 *   TEST_VALKEY_URL=redis://127.0.0.1:6379 \
 *   TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
 *   bun test
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { type SQL, sql } from "drizzle-orm";
import { drizzle as drizzleBunSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Miniflare } from "miniflare";
import pg from "pg";
import { loadConfig } from "../../src/config.ts";
import { createPgAccountClosingRepo } from "../../src/db/account-closing.pg.ts";
import { createSqliteAccountClosingRepo } from "../../src/db/account-closing.sqlite.ts";
import { pgSchema } from "../../src/db/pg-shared.ts";
import { createPgPlanRepo } from "../../src/db/plans.pg.ts";
import { createSqlitePlanRepo } from "../../src/db/plans.sqlite.ts";
import { createPgRateLimitRepo } from "../../src/db/rate-limits.pg.ts";
import { createSqliteRateLimitRepo } from "../../src/db/rate-limits.sqlite.ts";
import { sqliteSchema } from "../../src/db/sqlite-shared.ts";
import { handleEmail } from "../../src/ids.ts";
import { createValkeyKv } from "../../src/kv/valkey.ts";
import { createWorkersKv } from "../../src/kv/workers-kv.ts";
import type {
  AccountClosingRepo,
  KvStore,
  PlanRepo,
  PlanStorage,
  RateLimitRepo,
} from "../../src/services/types.ts";
import { createS3Storage } from "../../src/storage/s3.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

/** Blank counts as unset: an empty variable is not an opt-in. */
const read = (name: string) => process.env[name]?.trim() || undefined;

export const DATABASE_URL = read("TEST_DATABASE_URL");
export const VALKEY_URL = read("TEST_VALKEY_URL");
export const S3_ENDPOINT = read("TEST_S3_ENDPOINT");
const S3_ACCESS_KEY_ID = read("TEST_S3_ACCESS_KEY_ID") ?? "bunkerplan";
const S3_SECRET_ACCESS_KEY =
  read("TEST_S3_SECRET_ACCESS_KEY") ?? "bunkerplan-secret";

const PG_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Bound for the `beforeAll`/`afterAll` that open and close a fixture. Bun
 * defaults a hook to 5 seconds, and opening one of these is not a 5 second
 * operation on a loaded machine: bundling a Worker, booting workerd, applying
 * seven migrations to a cold Postgres, creating a bucket. Tests run one
 * process per file, so on a four-core runner all of that happens at once.
 *
 * Generous on purpose. It exists to fail a fixture that has genuinely hung,
 * not to police how long a cold start takes - a hook that times out under
 * load is a flake, and a flaky conformance suite gets ignored.
 */
export const FIXTURE_TIMEOUT_MS = 120_000;

/**
 * A store under test plus the teardown that releases it. `unique` prefixes
 * ids so suites sharing one server cannot collide: Miniflare and bun:sqlite
 * get a fresh instance each time, but Postgres, Valkey, and MinIO are one
 * long-lived server per run.
 */
export interface Fixture<T> {
  subject: T;
  unique: string;
  close(): Promise<void>;
}

/** Reads and writes raw keys, bypassing the driver's `plans/` mapping. */
export interface RawStore {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  keys(): Promise<string[]>;
}

export interface StorageFixture extends Fixture<PlanStorage> {
  raw: RawStore;
}

/**
 * A SQL backend with the real migrations applied.
 *
 * Everything past the three repos is a helper the conformance suites need but
 * cannot express portably: the placeholder syntax, the column types, and the
 * way a timestamp is stored all differ between SQLite and Postgres. Keeping
 * that here means the contracts contain no dialect at all, so a divergence
 * shows up as a failing assertion rather than as SQL one server rejects.
 */
export interface DbFixture {
  plans: PlanRepo;
  rateLimits: RateLimitRepo;
  accountClosing: AccountClosingRepo;
  /**
   * Creates a `user` row and returns its id; every repo needs one for the FK.
   * A `handle` sets `name` and the `@passkey.invalid` address grants are
   * addressed by, which the grant contract needs.
   */
  seedUser(handle?: string): Promise<string>;
  /** Removes the user, exercising the ON DELETE CASCADE the schema declares. */
  deleteUser(userId: string): Promise<void>;
  /** Rewrites a plan's `created_at`, so ordering is asserted without waiting. */
  backdatePlan(id: string, epochMs: number): Promise<void>;
  /** Rewrites a counter's window start, so rollover is asserted without waiting. */
  backdateRateWindow(key: string, epochMs: number): Promise<void>;
  /** The stored window start, to prove a refusal did not move it. */
  rateWindowStart(key: string): Promise<number>;
  countPlans(userId: string): Promise<number>;
  countRateLimits(key: string): Promise<number>;
  countAccountClosings(userId: string): Promise<number>;
  /** Inserts a passkey row; rejects when the credential id is already claimed. */
  addPasskey(userId: string, credentialId: string): Promise<void>;
  countPasskeys(userId: string): Promise<number>;
  close(): Promise<void>;
}

/** Migration statements in order, for one dialect. */
function migrations(
  dialect: "sqlite" | "pg",
  rewrite?: (sql: string) => string,
) {
  const dir = `${ROOT}/drizzle/${dialect}`;
  const statements: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const body = readFileSync(`${dir}/${file}`, "utf8");
    for (const statement of (rewrite === undefined ? body : rewrite(body))
      .split("--> statement-breakpoint")
      .map((part) => part.trim())) {
      if (statement !== "") statements.push(statement);
    }
  }
  return statements;
}

// ---------------------------------------------------------------------------
// Cloudflare: Miniflare, serving R2, KV, and D1 through real workerd.
// ---------------------------------------------------------------------------

/**
 * KV and D1 are driven straight from the test process: their proxied bindings
 * return strings and plain rows, which cross the boundary intact. R2 is not -
 * see tests/drivers/worker/r2-entry.ts - so it gets its own instance with the
 * driver bundled in. Everything is in-memory and thrown away with `dispose()`.
 */
const INERT =
  "export default { fetch: () => new Response(null,{status:404}) };";

function miniflare(): Miniflare {
  return new Miniflare({
    modules: true,
    script: INERT,
    kvNamespaces: ["KV"],
    d1Databases: ["DB"],
  });
}

/**
 * The R2 driver, bundled for workerd. Bundled rather than registered as two
 * modules so Miniflare never has to resolve a specifier: the entry and
 * src/storage/r2.ts arrive as one self-contained ESM.
 */
async function r2Worker(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [`${ROOT}/tests/drivers/worker/r2-entry.ts`],
    target: "browser",
    format: "esm",
  });
  if (!built.success) {
    throw new Error(`bundling the R2 worker failed:\n${built.logs.join("\n")}`);
  }
  const [output] = built.outputs;
  if (output === undefined) throw new Error("the R2 worker bundle was empty");
  return await output.text();
}

export async function r2Storage(): Promise<StorageFixture> {
  const mf = new Miniflare({
    modules: true,
    script: await r2Worker(),
    r2Buckets: ["BUCKET"],
  });
  const bucket = await mf.getR2Bucket("BUCKET");

  /** Rethrows a driver failure rather than letting it read as a miss. */
  async function call(op: string, id: string, body?: Uint8Array) {
    const url = `http://r2/${op}?id=${encodeURIComponent(id)}`;
    const response = await mf.dispatchFetch(
      url,
      body === undefined ? {} : { method: "POST", body },
    );
    if (response.status >= 500) {
      throw new Error(`R2 ${op} failed: ${await response.text()}`);
    }
    return response;
  }

  return {
    subject: {
      put: async (id, body) => {
        // `body` is consumed by the dispatch, so nothing is left buffered.
        await (await call("put", id, body)).arrayBuffer();
      },
      get: async (id) => {
        const response = await call("get", id);
        if (response.status === 404) {
          await response.arrayBuffer();
          return null;
        }
        return {
          body: response.body as unknown as ReadableStream<Uint8Array>,
          size: Number(response.headers.get("x-plan-size")),
          etag: response.headers.get("x-plan-etag") ?? "",
        };
      },
      delete: async (id) => {
        await (await call("delete", id)).arrayBuffer();
      },
      probe: async () => {
        await (await call("probe", "")).arrayBuffer();
      },
    },
    unique: "r2",
    raw: {
      put: async (key, body) => {
        await bucket.put(key, body);
      },
      // `text()` rather than `.body`: reading the stream property off a
      // proxied R2ObjectBody is the thing that cannot cross the boundary.
      get: async (key) => {
        const object = await bucket.get(key);
        return object === null ? null : await object.text();
      },
      keys: async () => (await bucket.list()).objects.map((o) => o.key),
    },
    close: () => mf.dispose(),
  };
}

export async function workersKv(): Promise<Fixture<KvStore>> {
  const mf = miniflare();
  const namespace = (await mf.getKVNamespace("KV")) as unknown as KVNamespace;
  return {
    subject: createWorkersKv(namespace),
    unique: "kv",
    close: () => mf.dispose(),
  };
}

export async function d1Db(): Promise<DbFixture> {
  const mf = miniflare();
  const binding = await mf.getD1Database("DB");
  // D1 enforces foreign keys unconditionally, so the cascades in the schema
  // are live here with no pragma - see src/db/d1.ts.
  for (const statement of migrations("sqlite")) {
    await binding.prepare(statement).run();
  }
  return sqliteFixture(
    drizzleD1(binding as never, { schema: sqliteSchema }),
    () => mf.dispose(),
  );
}

// ---------------------------------------------------------------------------
// Self-hosted: bun:sqlite, Postgres, Valkey, MinIO.
// ---------------------------------------------------------------------------

type SqliteDb = Parameters<typeof createSqlitePlanRepo>[0];

/**
 * One set of helpers for both SQLite drivers. D1 and bun:sqlite differ in how
 * a statement is dispatched, not in the SQL, so they share this - and a suite
 * passing on one and failing on the other then means a real driver difference
 * rather than a difference in how the test reached the database.
 */
function sqliteFixture(db: SqliteDb, close: () => Promise<void>): DbFixture {
  return {
    plans: createSqlitePlanRepo(db),
    rateLimits: createSqliteRateLimitRepo(db),
    accountClosing: createSqliteAccountClosingRepo(db),

    seedUser: async (handle) => {
      const id = `u-${crypto.randomUUID()}`;
      const name = handle ?? id;
      const email =
        handle === undefined ? `${id}@example.test` : handleEmail(handle);
      await db.run(
        sql`insert into user (id, name, email, email_verified, created_at, updated_at)
            values (${id}, ${name}, ${email}, 0, ${Date.now()}, ${Date.now()})`,
      );
      return id;
    },
    deleteUser: async (userId) => {
      await db.run(sql`delete from user where id = ${userId}`);
    },
    backdatePlan: async (id, epochMs) => {
      await db.run(
        sql`update plan set created_at = ${epochMs} where id = ${id}`,
      );
    },
    backdateRateWindow: async (key, epochMs) => {
      await db.run(
        sql`update upload_rate_limit set window_start = ${epochMs} where key = ${key}`,
      );
    },
    countPlans: (userId) =>
      sqliteCount(
        db,
        sql`select count(*) as v from plan where user_id = ${userId}`,
      ),
    rateWindowStart: (key) =>
      sqliteCount(
        db,
        sql`select window_start as v from upload_rate_limit where key = ${key}`,
      ),
    countRateLimits: (key) =>
      sqliteCount(
        db,
        sql`select count(*) as v from upload_rate_limit where key = ${key}`,
      ),
    countAccountClosings: (userId) =>
      sqliteCount(
        db,
        sql`select count(*) as v from account_closing where user_id = ${userId}`,
      ),
    addPasskey: async (userId, credentialId) => {
      await db.run(
        sql`insert into passkey
              (id, public_key, user_id, credential_id, counter, device_type, backed_up)
            values (${`pk-${crypto.randomUUID()}`}, 'pk', ${userId}, ${credentialId},
                    0, 'singleDevice', 0)`,
      );
    },
    countPasskeys: (userId) =>
      sqliteCount(
        db,
        sql`select count(*) as v from passkey where user_id = ${userId}`,
      ),
    close,
  };
}

async function sqliteCount(db: SqliteDb, statement: SQL): Promise<number> {
  const rows = await db.all<{ v: number }>(statement);
  return Number(rows[0]?.v ?? 0);
}

export async function bunSqliteDb(): Promise<DbFixture> {
  const handle = new Database(":memory:");
  // Off by default per connection, so without this every ON DELETE CASCADE in
  // the schema silently does nothing - the exact bug src/db/bun-sqlite.ts
  // guards against, and what the cascade assertions here would miss.
  handle.exec("PRAGMA foreign_keys = ON");
  for (const statement of migrations("sqlite")) handle.exec(statement);
  return sqliteFixture(
    drizzleBunSqlite(handle, { schema: sqliteSchema }),
    async () => {
      handle.close();
    },
  );
}

/**
 * Everything lives in a scratch schema named for this run and dropped
 * afterwards, so pointing `TEST_DATABASE_URL` at a database that already holds
 * a `plan` table cannot destroy it.
 */
export async function postgresDb(): Promise<DbFixture> {
  if (DATABASE_URL === undefined) throw new Error("TEST_DATABASE_URL unset");
  const schema = `bunkerplan_test_${crypto.randomUUID().replaceAll("-", "")}`;

  const bootstrap = new pg.Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
  });
  await bootstrap.connect();
  await bootstrap.query(`create schema "${schema}"`);
  await bootstrap.end();

  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
    options: `-c search_path=${schema}`,
  });
  const db = drizzlePg(pool, { schema: pgSchema });

  // `search_path` places every unqualified `create` in the scratch schema;
  // drizzle also emits explicit `"public".` on its foreign keys, redirected
  // the same way so nothing reaches the real schema.
  for (const statement of migrations("pg", (body) =>
    body.replaceAll('"public".', `"${schema}".`),
  )) {
    await db.execute(sql.raw(statement));
  }

  const count = async (statement: SQL): Promise<number> => {
    const result = await db.execute<{ v: string }>(statement);
    return Number(result.rows[0]?.v ?? 0);
  };

  return {
    plans: createPgPlanRepo(db),
    rateLimits: createPgRateLimitRepo(db),
    accountClosing: createPgAccountClosingRepo(db),

    seedUser: async (handle) => {
      const id = `u-${crypto.randomUUID()}`;
      const name = handle ?? id;
      const email =
        handle === undefined ? `${id}@example.test` : handleEmail(handle);
      await db.execute(
        sql`insert into "user" (id, name, email, email_verified, created_at, updated_at)
            values (${id}, ${name}, ${email}, false, now(), now())`,
      );
      return id;
    },
    deleteUser: async (userId) => {
      await db.execute(sql`delete from "user" where id = ${userId}`);
    },
    // `created_at` is a timestamp here and epoch milliseconds on SQLite, which
    // is exactly why the contracts never write this themselves.
    backdatePlan: async (id, epochMs) => {
      await db.execute(
        sql`update plan set created_at = to_timestamp(${epochMs}::bigint / 1000.0)
            where id = ${id}`,
      );
    },
    backdateRateWindow: async (key, epochMs) => {
      await db.execute(
        sql`update upload_rate_limit set window_start = ${epochMs} where key = ${key}`,
      );
    },
    countPlans: (userId) =>
      count(sql`select count(*) as v from plan where user_id = ${userId}`),
    rateWindowStart: (key) =>
      count(
        sql`select window_start as v from upload_rate_limit where key = ${key}`,
      ),
    countRateLimits: (key) =>
      count(
        sql`select count(*) as v from upload_rate_limit where key = ${key}`,
      ),
    countAccountClosings: (userId) =>
      count(
        sql`select count(*) as v from account_closing where user_id = ${userId}`,
      ),
    addPasskey: async (userId, credentialId) => {
      await db.execute(
        sql`insert into passkey
              (id, public_key, user_id, credential_id, counter, device_type, backed_up)
            values (${`pk-${crypto.randomUUID()}`}, 'pk', ${userId}, ${credentialId},
                    0, 'singleDevice', false)`,
      );
    },
    countPasskeys: (userId) =>
      count(sql`select count(*) as v from passkey where user_id = ${userId}`),
    close: async () => {
      await pool.query(`drop schema if exists "${schema}" cascade`);
      await pool.end();
    },
  };
}

export async function valkeyKv(): Promise<Fixture<KvStore>> {
  if (VALKEY_URL === undefined) throw new Error("TEST_VALKEY_URL unset");
  const subject = createValkeyKv(VALKEY_URL);
  // Fails here rather than inside the first assertion, where an unreachable
  // server would look like a driver bug.
  await subject.probe();
  return {
    subject,
    unique: `valkey-${crypto.randomUUID()}`,
    // The driver owns its ioredis client and exposes no handle, so the
    // connection is dropped by the process ending. Keys are namespaced per
    // run instead of deleted, which also keeps a shared server usable.
    close: async () => {},
  };
}

/**
 * MinIO through the same `createS3Storage` a self-hosted deployment gets,
 * configured through `loadConfig` so the environment contract in
 * docs/self-hosting.md is what is exercised rather than a hand-built object.
 *
 * The bucket is created for this run and dropped with it, which is the same
 * containment the Postgres fixture gets from its scratch schema. Nothing here
 * may name a bucket an operator chose: `close()` empties whatever it is
 * pointed at, and a suite that can delete real objects is not worth running.
 */
export async function s3Storage(): Promise<StorageFixture> {
  if (S3_ENDPOINT === undefined) throw new Error("TEST_S3_ENDPOINT unset");
  const bucket = `bunkerplan-test-${crypto.randomUUID()}`;

  const client = new S3Client({
    region: "us-east-1",
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
  });
  // No catch: the name is a fresh UUID, so a conflict is impossible and
  // anything thrown here is a real failure - credentials, a wrong endpoint,
  // a server that is not up. Once opted in, that must fail the suite.
  await client.send(new CreateBucketCommand({ Bucket: bucket }));

  const config = loadConfig({
    BETTER_AUTH_SECRET: "s3-conformance-0123456789abcdef0123456789",
    PUBLIC_BASE_URL: "http://localhost:3000",
    CLIENT_IP_HEADER: "x-forwarded-for",
    STORAGE_DRIVER: "s3",
    DB_DRIVER: "sqlite",
    KV_DRIVER: "valkey",
    VALKEY_URL: "redis://127.0.0.1:6379",
    S3_BUCKET: bucket,
    S3_ENDPOINT,
    S3_REGION: "us-east-1",
    S3_FORCE_PATH_STYLE: "true",
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
  });

  return {
    subject: createS3Storage(config),
    unique: "s3",
    raw: {
      put: async (key, body) => {
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
        );
      },
      get: async (key) => {
        try {
          const response = await client.send(
            new GetObjectCommand({ Bucket: bucket, Key: key }),
          );
          return (await response.Body?.transformToString()) ?? null;
        } catch (error) {
          if (error instanceof Error && error.name === "NoSuchKey") return null;
          throw error;
        }
      },
      keys: async () => {
        const listed = await client.send(
          new ListObjectsV2Command({ Bucket: bucket }),
        );
        return (listed.Contents ?? []).flatMap((object) =>
          object.Key === undefined ? [] : [object.Key],
        );
      },
    },
    close: async () => {
      // S3 refuses to drop a bucket that still holds objects, and a run that
      // left one behind would leak a bucket per run on a shared server.
      for (;;) {
        const listed = await client.send(
          new ListObjectsV2Command({ Bucket: bucket }),
        );
        const contents = listed.Contents ?? [];
        if (contents.length === 0) break;
        for (const object of contents) {
          if (object.Key === undefined) continue;
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
          );
        }
        if (listed.IsTruncated !== true) break;
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      client.destroy();
    },
  };
}
