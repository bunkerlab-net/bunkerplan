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
import type { Dialect } from "../../src/db/dialect.ts";
import { type PgDb, pgDialect, pgSchema } from "../../src/db/pg-shared.ts";
import { createUnlockRateLimitRepo } from "../../src/db/rate-limits.shared.ts";
import { createDialectRepos } from "../../src/db/repos.ts";
import {
  type SqliteDb,
  sqliteDialect,
  sqliteSchema,
} from "../../src/db/sqlite-shared.ts";
import { handleEmail } from "../../src/ids.ts";
import { createValkeyKv, type ValkeyKv } from "../../src/kv/valkey.ts";
import { createWorkersKv } from "../../src/kv/workers-kv.ts";
import type {
  AccountClosingRepo,
  KvStore,
  PlanRepo,
  PlanStorage,
  RateLimitRepo,
} from "../../src/services/types.ts";
import { createS3Storage } from "../../src/storage/s3.ts";
import { silentLogger } from "../fakes.ts";
import { migrationFiles } from "../migration-files.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

/** Blank counts as unset: an empty variable is not an opt-in. */
const read = (name: string) => process.env[name]?.trim() || undefined;

export const DATABASE_URL = read("TEST_DATABASE_URL");
export const VALKEY_URL = read("TEST_VALKEY_URL");
export const S3_ENDPOINT = read("TEST_S3_ENDPOINT");
const S3_ACCESS_KEY_ID = read("TEST_S3_ACCESS_KEY_ID") ?? "minioadmin";
const S3_SECRET_ACCESS_KEY = read("TEST_S3_SECRET_ACCESS_KEY") ?? "minioadmin";

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
 * Everything past the repositories is a helper the conformance suites need but
 * cannot express portably: the placeholder syntax, the column types, and the
 * way a timestamp is stored all differ between SQLite and Postgres. Keeping
 * that here means the contracts contain no dialect at all, so a divergence
 * shows up as a failing assertion rather than as SQL one server rejects.
 */
export interface DbFixture {
  plans: PlanRepo;
  rateLimits: RateLimitRepo;
  /** The unlock bucket, whose key is a client address rather than a user id. */
  unlockRateLimits: RateLimitRepo;
  /**
   * The same bucket with the sweep bounded to one row, so the batching is
   * assertable without seeding a production-sized backlog against three real
   * servers. Always sweeps, as `unlockRateLimits` does.
   */
  unlockRateLimitsOneAtATime: RateLimitRepo;
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
  /** Ages an unlock counter's window, so rollover needs no waiting. */
  backdateUnlockWindow(key: string, epochMs: number): Promise<void>;
  /** Unlock rows, all of them or the one a key names. */
  countUnlockRows(key?: string): Promise<number>;
  countPlans(userId: string): Promise<number>;
  countRateLimits(key: string): Promise<number>;
  countAccountClosings(userId: string): Promise<number>;
  /** Inserts a passkey row; rejects when the credential id is already claimed. */
  addPasskey(userId: string, credentialId: string): Promise<void>;
  countPasskeys(userId: string): Promise<number>;
  /**
   * Inserts an api key owned by the user; rejects when no such user exists.
   * The api-key plugin declares no foreign key on the column, so the one the
   * schema carries is ours - see the note in src/auth/options.ts.
   */
  addApiKey(userId: string): Promise<void>;
  countApiKeys(userId: string): Promise<number>;
  /**
   * Inserts a plan row with `visibility` set to whatever is asked, bypassing
   * `PlanRepo` and its `PlanVisibility` type. The CHECK constraint is only
   * worth having against a writer the type does not cover, so the test needs
   * a way to be that writer.
   */
  insertPlanWithVisibility(
    id: string,
    userId: string,
    visibility: string,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Migration statements in order, for one dialect. */
function migrations(
  dialect: "sqlite" | "pg",
  rewrite?: (sql: string) => string,
) {
  return migrationFiles(dialect, rewrite).flatMap((file) => file.statements);
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

/**
 * The repository set, which no longer differs by dialect: `Dialect` is the
 * seam, and every driver difference lives behind it. Named once so another
 * repository is one edit rather than two - which is how the bounded-sweep
 * unlock bucket came to sit beside the ordinary one without a second copy of
 * everything around it.
 */
function repos(
  dialect: Dialect,
): Pick<
  DbFixture,
  | "plans"
  | "rateLimits"
  | "unlockRateLimits"
  | "unlockRateLimitsOneAtATime"
  | "accountClosing"
> {
  // The production wiring, so the contract suites exercise the repositories a
  // deployment gets rather than a second set assembled here. `rateLimits` is
  // the fixture's name for the upload bucket, and the unlock ones are rebuilt
  // to sweep every time: the pruning contract asserts a closed window is gone,
  // and the default fires on a fraction of attempts.
  const wired = createDialectRepos(dialect, silentLogger);
  return {
    plans: wired.plans,
    rateLimits: wired.uploadRateLimits,
    unlockRateLimits: createUnlockRateLimitRepo(dialect, silentLogger, {
      shouldSweep: () => true,
    }),
    unlockRateLimitsOneAtATime: createUnlockRateLimitRepo(
      dialect,
      silentLogger,
      { shouldSweep: () => true, batch: 1 },
    ),
    accountClosing: wired.accountClosing,
  };
}

/**
 * How a fixture reaches its database for the helper SQL below.
 *
 * The repositories go through `Dialect`, but these helpers deliberately do
 * not: they exist to write and read state the repositories cannot, so a bug
 * in the seam must not be able to hide by breaking both sides the same way.
 * The two drivers dispatch a statement differently - `run`/`all` against a
 * SQLite handle, `execute` against a pool - and that is the whole of it.
 */
interface Exec {
  run(statement: SQL): Promise<void>;
  /** The `v` column of the first row of a `select ... as v`, or zero. */
  count(statement: SQL): Promise<number>;
}

/**
 * The four places the helper SQL genuinely cannot be shared.
 *
 * Everything else below is one statement for both servers. Keeping the
 * differences to a named list is what makes it obvious how few there are,
 * rather than leaving two 15-method bodies to be diffed by eye.
 */
interface Fragments {
  /** `user` is reserved in Postgres and must be quoted; SQLite must not. */
  user: SQL;
  /** A `timestamp` column on Postgres, epoch milliseconds on SQLite. */
  instant(epochMs: number): SQL;
  /** A thunk on both: one fixture seeds many rows, at different instants. */
  now(): SQL;
  /** A real `boolean` on Postgres, an integer on SQLite. */
  no: SQL;
}

/**
 * One `DbFixture` body for both dialects.
 *
 * Everything past the repositories is a helper the conformance suites need
 * but cannot express portably. It was written out twice, and the two copies
 * differed only in how a statement was dispatched and in the four fragments
 * above - which is not a difference worth 100 duplicated lines, and is how
 * the `insertPlanWithVisibility` helper came to be added to one and not the
 * other.
 */
function dbFixture(
  dialect: Dialect,
  exec: Exec,
  frag: Fragments,
  close: () => Promise<void>,
): DbFixture {
  return {
    ...repos(dialect),

    seedUser: async (handle) => {
      const id = `u-${crypto.randomUUID()}`;
      const name = handle ?? id;
      const email =
        handle === undefined ? `${id}@example.test` : handleEmail(handle);
      await exec.run(
        sql`insert into ${frag.user} (id, name, email, email_verified, created_at, updated_at)
            values (${id}, ${name}, ${email}, ${frag.no}, ${frag.now()}, ${frag.now()})`,
      );
      return id;
    },
    deleteUser: async (userId) => {
      await exec.run(sql`delete from ${frag.user} where id = ${userId}`);
    },
    // `created_at` is a timestamp on Postgres and epoch milliseconds on
    // SQLite, which is exactly why the contracts never write this themselves.
    backdatePlan: async (id, epochMs) => {
      await exec.run(
        sql`update plan set created_at = ${frag.instant(epochMs)} where id = ${id}`,
      );
    },
    backdateRateWindow: async (key, epochMs) => {
      await exec.run(
        sql`update upload_rate_limit set window_start = ${epochMs} where key = ${key}`,
      );
    },
    countPlans: (userId) =>
      exec.count(sql`select count(*) as v from plan where user_id = ${userId}`),
    rateWindowStart: (key) =>
      exec.count(
        sql`select window_start as v from upload_rate_limit where key = ${key}`,
      ),
    countRateLimits: (key) =>
      exec.count(
        sql`select count(*) as v from upload_rate_limit where key = ${key}`,
      ),
    backdateUnlockWindow: async (key, epochMs) => {
      await exec.run(
        sql`update unlock_rate_limit set window_start = ${epochMs} where key = ${key}`,
      );
    },
    countUnlockRows: (key) =>
      exec.count(
        key === undefined
          ? sql`select count(*) as v from unlock_rate_limit`
          : sql`select count(*) as v from unlock_rate_limit where key = ${key}`,
      ),
    countAccountClosings: (userId) =>
      exec.count(
        sql`select count(*) as v from account_closing where user_id = ${userId}`,
      ),
    addPasskey: async (userId, credentialId) => {
      await exec.run(
        sql`insert into passkey
              (id, public_key, user_id, credential_id, counter, device_type, backed_up)
            values (${`pk-${crypto.randomUUID()}`}, 'pk', ${userId}, ${credentialId},
                    0, 'singleDevice', ${frag.no})`,
      );
    },
    countPasskeys: (userId) =>
      exec.count(
        sql`select count(*) as v from passkey where user_id = ${userId}`,
      ),
    addApiKey: async (userId) => {
      await exec.run(
        sql`insert into apikey (id, reference_id, key, created_at, updated_at)
            values (${`ak-${crypto.randomUUID()}`}, ${userId},
                    ${`key-${crypto.randomUUID()}`}, ${frag.now()}, ${frag.now()})`,
      );
    },
    countApiKeys: (userId) =>
      exec.count(
        sql`select count(*) as v from apikey where reference_id = ${userId}`,
      ),
    insertPlanWithVisibility: async (id, userId, visibility) => {
      await exec.run(
        sql`insert into plan (id, user_id, size, visibility)
            values (${id}, ${userId}, 1, ${visibility})`,
      );
    },
    close,
  };
}

/**
 * One set of helpers for both SQLite drivers. D1 and bun:sqlite differ in how
 * a statement is dispatched, not in the SQL, so they share this - and a suite
 * passing on one and failing on the other then means a real driver difference
 * rather than a difference in how the test reached the database.
 */
function sqliteFixture(db: SqliteDb, close: () => Promise<void>): DbFixture {
  return dbFixture(
    sqliteDialect(db),
    {
      run: async (statement) => {
        await db.run(statement);
      },
      count: async (statement) => {
        const rows = await db.all<{ v: number }>(statement);
        return Number(rows[0]?.v ?? 0);
      },
    },
    {
      user: sql.raw("user"),
      // Epoch milliseconds straight into an integer column.
      instant: (epochMs) => sql`${epochMs}`,
      now: () => sql`${Date.now()}`,
      no: sql`0`,
    },
    close,
  );
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

  return pgFixture(db, async () => {
    // `finally`, so a drop that fails still closes the pool. Left open, its
    // clients keep the process alive past the suite and every later file pays
    // for it - and the drop failing is exactly when that is most likely, since
    // something is already wrong with the server.
    try {
      await pool.query(`drop schema if exists "${schema}" cascade`);
    } finally {
      await pool.end();
    }
  });
}

/**
 * The Postgres half of the same body, named for symmetry with
 * `sqliteFixture`. It had no name at all: it was an object literal inside
 * `postgresDb`, which is how the two copies drifted without anyone noticing.
 */
function pgFixture(db: PgDb, close: () => Promise<void>): DbFixture {
  return dbFixture(
    pgDialect(db),
    {
      run: async (statement) => {
        await db.execute(statement);
      },
      count: async (statement) => {
        // `count(*)` comes back as a string here, not a number.
        const result = await db.execute<{ v: string }>(statement);
        return Number(result.rows[0]?.v ?? 0);
      },
    },
    {
      // Reserved word, so the identifier has to be quoted.
      user: sql.raw('"user"'),
      // A `timestamp` column, so the milliseconds have to be converted - and
      // pinned to UTC. `to_timestamp` yields a `timestamptz`, and storing that
      // into a column without a zone converts it through the session's
      // `TimeZone`, so the same epoch would land differently on a server whose
      // default is not UTC. `dialect.createdAt` reads the column back as UTC,
      // so this is the half that has to agree with it.
      instant: (epochMs) =>
        sql`(to_timestamp(${epochMs}::bigint / 1000.0) at time zone 'UTC')`,
      now: () => sql`now()`,
      no: sql`false`,
    },
    close,
  );
}

export async function valkeyKv(): Promise<Fixture<ValkeyKv>> {
  if (VALKEY_URL === undefined) throw new Error("TEST_VALKEY_URL unset");
  const subject = createValkeyKv(VALKEY_URL);
  // Fails here rather than inside the first assertion, where an unreachable
  // server would look like a driver bug - and the client goes with it. ioredis
  // keeps retrying a connection it cannot make, so a probe that rejected and
  // left the client open would leak a socket and its retry timers for the rest
  // of the run, on the one path where the server is already misbehaving.
  try {
    await subject.probe();
  } catch (cause) {
    await subject.close();
    throw cause;
  }
  return {
    subject,
    unique: `valkey-${crypto.randomUUID()}`,
    // Keys are namespaced per run rather than deleted, which keeps a shared
    // server usable. The connection is not left to the process: under
    // `--isolate` other files' handles stay open in it, so a fixture that
    // never disconnects accumulates live clients for the whole run.
    close: async () => {
      await subject.close();
    },
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
