/**
 * Environment parsing. The variable names below are the self-hosting API -
 * see docs/self-hosting.md. Renaming one is a breaking change for operators.
 *
 * Every problem is collected and reported in a single Error so a misconfigured
 * container fails loudly at boot instead of on the first request.
 */

import { WORKERS_MAX_PLANS_PER_USER } from "./limits.ts";

export type StorageDriver = "r2" | "s3";
export type DbDriver = "d1" | "sqlite" | "postgres";
export type KvDriver = "kv" | "valkey";
export type LogFormat = "json" | "plain";

const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  secret: string;
  publicBaseUrl: string;
  rpId: string;
  rpName: string;
  /**
   * Single request header carrying the client IP, lowercased. Better Auth
   * derives its rate-limit bucket and the recorded session IP from it.
   */
  clientIpHeader: string;
  maxUploadBytes: number;
  planIdLength: number;
  shareCodeLength: number;
  /**
   * Per-account ceiling on stored plans. Bounds total storage at this times
   * `maxUploadBytes`, which the upload rate limit alone cannot do - that caps
   * how fast an account writes, never how much it keeps.
   */
  maxPlansPerUser: number;
  uploadRateMax: number;
  uploadRateWindowSec: number;
  /**
   * Share-code redemptions allowed per client address per window.
   *
   * Not a defence against guessing the code - that rests on its entropy, and
   * no reachable rate would change it. This bounds what an anonymous caller
   * can spend of the deployment's own resources on the one route that takes no
   * credential.
   */
  unlockRateMax: number;
  unlockRateWindowSec: number;
  logFormat: LogFormat;
  logLevel: LogLevel;
  logColor: boolean;
  storageDriver: StorageDriver;
  s3Endpoint: string | undefined;
  s3Bucket: string | undefined;
  s3AccessKeyId: string | undefined;
  s3SecretAccessKey: string | undefined;
  s3Region: string;
  s3ForcePathStyle: boolean;
  dbDriver: DbDriver;
  sqlitePath: string;
  databaseUrl: string | undefined;
  kvDriver: KvDriver;
  valkeyUrl: string | undefined;
}

export interface LoadConfigOptions {
  /** True on Cloudflare Workers, where the driver defaults are the bindings. */
  workers?: boolean;
}

/** Values are whatever the runtime supplies; `str` coerces them to text. */
type Env = Record<string, unknown>;

const DEFAULT_MAX_PLANS_PER_USER = 250;
const MIN_SECRET_LENGTH = 32;
/**
 * Floor on `UPLOAD_RATE_WINDOW_SEC`. A policy floor, not a platform one: the
 * counter is a database row with millisecond precision (src/db/rate-limits.*),
 * so nothing technical stops a shorter window. What stops it is that
 * `UPLOAD_RATE_MAX` is a count *per window*, so shrinking the window silently
 * multiplies the sustained upload rate while reading like a tightening - and
 * uploads are the one limit standing between an account and the deployment's
 * storage bill. The Workers KV `expirationTtl` minimum this used to cite is a
 * fact about a different subsystem; it lives at MIN_TTL_SECONDS in
 * src/kv/min-ttl.ts, where both KV drivers read it.
 *
 * Exported so the test asserting the refusal reads the floor instead of
 * repeating it. Here and not in src/limits.ts: that module carries ceilings
 * the wire can see - page sizes, quotas, the visibility enum - and this is a
 * bound on one environment variable, meaningful only to the loader that
 * enforces it.
 */
export const MIN_RATE_WINDOW_SEC = 60;
const DEFAULT_MAX_UPLOAD_BYTES = 2_097_152;
const DEFAULT_PLAN_ID_LENGTH = 16;
/**
 * A public plan URL is unlisted, so the id is the only thing keeping that
 * document from being found by guessing - and for a private one the id still
 * bounds what the gate leaks, since a 401 confirms a plan exists. Eight
 * lowercase alphanumeric characters is about 41 bits, the floor worth
 * allowing.
 */
const MIN_PLAN_ID_LENGTH = 8;
/**
 * A plan id is a single DNS label's worth of characters, and RFC 1035 caps a
 * label at 63. Nothing today needs that - plans are served from `/p/{id}` -
 * but the alphabet is lowercase for the same reason (see src/ids.ts), and a
 * ceiling is what makes the pair an enforced invariant rather than a
 * convention: every id this app can mint fits in a hostname, so moving plans
 * to `{id}.{host}` stays a redirect instead of a re-encoding.
 */
const MAX_PLAN_ID_LENGTH = 63;
const DEFAULT_SHARE_CODE_LENGTH = 16;
/**
 * A share code is the only thing gating an unauthenticated read, so unlike a
 * plan id there is no short end worth allowing: 16 base62 characters is ~95
 * bits, and the floor is the default. Exported for the same reason as the
 * ceiling - it is the stable bound the API documents accepting, independent
 * of what this deployment mints.
 */
export const MIN_SHARE_CODE_LENGTH = 16;
/**
 * The ceiling on a minted code, and so also the longest `?code=` the read gate
 * will hash. Exported because those two have to be the same number: a gate
 * bounded lower than this would silently refuse codes this deployment can
 * mint.
 */
export const MAX_SHARE_CODE_LENGTH = 64;

function str(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null) return undefined;
  // Coerced, not required to be a string: `vars` in wrangler.jsonc is JSON, so
  // an unquoted `"UPLOAD_RATE_MAX": 30` reaches the Worker as a number. Every
  // parser below works from text, and silently ignoring a var an operator
  // plainly set is worse than accepting either spelling.
  const trimmed = String(raw).trim();
  return trimmed === "" ? undefined : trimmed;
}

function bool(
  env: Env,
  key: string,
  fallback: boolean,
  problems: string[],
): boolean {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  if (lowered === "true" || lowered === "1") return true;
  if (lowered === "false" || lowered === "0") return false;
  problems.push(`${key} must be "true" or "false", got "${raw}"`);
  return fallback;
}

function int(
  env: Env,
  key: string,
  fallback: number,
  min: number,
  problems: string[],
  max?: number,
): number {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < min ||
    (max !== undefined && parsed > max)
  ) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    problems.push(`${key} must be an integer ${range}, got "${raw}"`);
    return fallback;
  }
  return parsed;
}

function oneOf<T extends string>(
  env: Env,
  key: string,
  allowed: readonly T[],
  fallback: T | undefined,
  problems: string[],
): T {
  const raw = str(env, key);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    problems.push(`${key} is required (one of: ${allowed.join(", ")})`);
    return allowed[0] as T;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    problems.push(`${key} must be one of: ${allowed.join(", ")}, got "${raw}"`);
    return fallback ?? (allowed[0] as T);
  }
  return raw as T;
}

/**
 * A driver setting, which means something different on each runtime.
 *
 * On Workers it is not dispatchable at all: src/runtime/cloudflare.ts wires the
 * D1, KV, and R2 bindings by name and nothing reachable from it may import
 * `pg`, `ioredis`, or `bun:sqlite` - the bundle would fail to resolve them. So
 * there the binding is the only accepted value: defaulted for an operator who
 * sets nothing, refused with an explanation for one who sets something else.
 * Accepting and ignoring is the outcome that closes - `DB_DRIVER=postgres` with
 * a `DATABASE_URL` used to boot clean on Workers and write every row to D1
 * regardless.
 *
 * Self-hosted it is a genuine choice and required, since no default is right
 * for every deployment - but the binding is refused there too, and by name.
 * src/runtime/node.ts cannot dispatch to it either and says so, one driver at
 * a time as it reaches each; refusing here instead is what makes an operator
 * who set all three see all three, which is the whole reason this file
 * collects problems rather than throwing on the first.
 */
function driver<T extends string>(
  env: Env,
  key: string,
  allowed: readonly T[],
  binding: T,
  workers: boolean,
  problems: string[],
): T {
  const raw = str(env, key);
  if (workers) {
    if (raw === undefined || raw === binding) return binding;
    problems.push(
      `${key} must be "${binding}" on Cloudflare Workers, got "${raw}": ` +
        "drivers there are bindings, not implementations this build can " +
        "dispatch to",
    );
    return binding;
  }

  // Named rather than left to `oneOf`, which would either list a value nothing
  // off Workers can dispatch to or omit it and leave an operator guessing why
  // a documented driver is rejected. Returned early so one wrong value is one
  // problem.
  const selfHosted = allowed.filter((value) => value !== binding);
  if (raw === binding) {
    problems.push(
      `${key}=${binding} is only available on Cloudflare Workers; use ` +
        `${selfHosted.join(" or ")} when self-hosting`,
    );
    return binding;
  }
  return oneOf(env, key, selfHosted, undefined, problems);
}

interface Drivers {
  storageDriver: StorageDriver;
  s3Bucket: string | undefined;
  s3AccessKeyId: string | undefined;
  s3SecretAccessKey: string | undefined;
  dbDriver: DbDriver;
  databaseUrl: string | undefined;
  kvDriver: KvDriver;
  valkeyUrl: string | undefined;
}

interface StorageSettings {
  storageDriver: StorageDriver;
  s3Bucket: string | undefined;
  s3AccessKeyId: string | undefined;
  s3SecretAccessKey: string | undefined;
}

function parseStorage(
  env: Env,
  workers: boolean,
  problems: string[],
): StorageSettings {
  const storageDriver = driver(
    env,
    "STORAGE_DRIVER",
    ["r2", "s3"] as const,
    "r2",
    workers,
    problems,
  );
  const s3Bucket = str(env, "S3_BUCKET");
  if (storageDriver === "s3" && s3Bucket === undefined) {
    problems.push("S3_BUCKET is required when STORAGE_DRIVER=s3");
  }
  const s3AccessKeyId = str(env, "S3_ACCESS_KEY_ID");
  const s3SecretAccessKey = str(env, "S3_SECRET_ACCESS_KEY");
  // Half-configured is rejected rather than silently falling through to the
  // provider chain - that failure mode surfaces as a confusing 403 much later.
  if ((s3AccessKeyId === undefined) !== (s3SecretAccessKey === undefined)) {
    problems.push(
      "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together, " +
        "or both omitted to use the AWS credential provider chain",
    );
  }
  return { storageDriver, s3Bucket, s3AccessKeyId, s3SecretAccessKey };
}

function parseDrivers(env: Env, workers: boolean, problems: string[]): Drivers {
  const storage = parseStorage(env, workers, problems);

  const dbDriver = driver(
    env,
    "DB_DRIVER",
    ["d1", "sqlite", "postgres"] as const,
    "d1",
    workers,
    problems,
  );
  const databaseUrl = str(env, "DATABASE_URL");
  if (dbDriver === "postgres" && databaseUrl === undefined) {
    problems.push("DATABASE_URL is required when DB_DRIVER=postgres");
  }

  const kvDriver = driver(
    env,
    "KV_DRIVER",
    ["kv", "valkey"] as const,
    "kv",
    workers,
    problems,
  );
  const valkeyUrl = str(env, "VALKEY_URL");
  if (kvDriver === "valkey" && valkeyUrl === undefined) {
    problems.push("VALKEY_URL is required when KV_DRIVER=valkey");
  }

  return { ...storage, dbDriver, databaseUrl, kvDriver, valkeyUrl };
}

interface Identity {
  secret: string;
  publicBaseUrl: string;
  baseHostname: string;
}

function parseIdentity(env: Env, problems: string[]): Identity {
  const secret = str(env, "BETTER_AUTH_SECRET") ?? "";
  if (secret === "") problems.push("BETTER_AUTH_SECRET is required");
  else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  const rawBaseUrl = str(env, "PUBLIC_BASE_URL");
  if (rawBaseUrl === undefined) {
    problems.push(
      "PUBLIC_BASE_URL is required (e.g. https://plans.example.com)",
    );
    return { secret, publicBaseUrl: "", baseHostname: "" };
  }
  try {
    const url = new URL(rawBaseUrl);
    return { secret, publicBaseUrl: url.origin, baseHostname: url.hostname };
  } catch {
    problems.push(`PUBLIC_BASE_URL is not a valid URL: "${rawBaseUrl}"`);
    return { secret, publicBaseUrl: "", baseHostname: "" };
  }
}

interface LogSettings {
  logFormat: LogFormat;
  logLevel: LogLevel;
  logColor: boolean;
}

function parseLogging(env: Env, problems: string[]): LogSettings {
  return {
    logFormat: oneOf(
      env,
      "LOG_FORMAT",
      ["json", "plain"] as const,
      "json",
      problems,
    ),
    logLevel: oneOf(env, "LOG_LEVEL", LOG_LEVELS, "info", problems),
    // Colour only means anything for the pretty renderer with a human
    // watching. Off by default so captured logs stay free of escape codes.
    logColor: bool(env, "LOG_COLOR", false, problems),
  };
}

interface Limits {
  maxUploadBytes: number;
  planIdLength: number;
  shareCodeLength: number;
  maxPlansPerUser: number;
  uploadRateMax: number;
  uploadRateWindowSec: number;
  unlockRateMax: number;
  unlockRateWindowSec: number;
}

function parseLimits(env: Env, workers: boolean, problems: string[]): Limits {
  return {
    maxUploadBytes: int(
      env,
      "MAX_UPLOAD_BYTES",
      DEFAULT_MAX_UPLOAD_BYTES,
      1,
      problems,
    ),
    planIdLength: int(
      env,
      "PLAN_ID_LENGTH",
      DEFAULT_PLAN_ID_LENGTH,
      MIN_PLAN_ID_LENGTH,
      problems,
      MAX_PLAN_ID_LENGTH,
    ),
    shareCodeLength: int(
      env,
      "SHARE_CODE_LENGTH",
      DEFAULT_SHARE_CODE_LENGTH,
      MIN_SHARE_CODE_LENGTH,
      problems,
      MAX_SHARE_CODE_LENGTH,
    ),
    // Capped on Workers, where an account that outgrows one invocation's
    // subrequest budget is an account whose deletion cannot finish in one
    // attempt - see WORKERS_MAX_PLANS_PER_USER.
    maxPlansPerUser: int(
      env,
      "MAX_PLANS_PER_USER",
      DEFAULT_MAX_PLANS_PER_USER,
      1,
      problems,
      workers ? WORKERS_MAX_PLANS_PER_USER : undefined,
    ),
    ...parseRateLimits(env, problems),
  };
}

/** The two counters: how much each allows, and over how long. */
type RateLimits = Pick<
  Limits,
  | "uploadRateMax"
  | "uploadRateWindowSec"
  | "unlockRateMax"
  | "unlockRateWindowSec"
>;

function parseRateLimits(env: Env, problems: string[]): RateLimits {
  return {
    uploadRateMax: int(env, "UPLOAD_RATE_MAX", 30, 1, problems),
    uploadRateWindowSec: int(
      env,
      "UPLOAD_RATE_WINDOW_SEC",
      MIN_RATE_WINDOW_SEC,
      MIN_RATE_WINDOW_SEC,
      problems,
    ),
    // Redeeming a share code is the one unauthenticated write, so its bucket
    // is the client address rather than an account. Generous by default: a
    // reader types a code once or twice, and a whole office can share one
    // address.
    unlockRateMax: int(env, "UNLOCK_RATE_MAX", 30, 1, problems),
    // No `MIN_RATE_WINDOW_SEC` floor, deliberately: that floor keeps the
    // upload rate honest against the storage it buys, and this counter buys
    // nothing durable - it only bounds work on the one unauthenticated route.
    // A shorter window is a weaker limit, which is the operator's call to
    // make.
    unlockRateWindowSec: int(env, "UNLOCK_RATE_WINDOW_SEC", 60, 1, problems),
  };
}

/**
 * The relying-party id scopes a passkey. A value the served hostname is not
 * equal to or a subdomain of makes every ceremony fail in the browser with an
 * opaque error, and a parent-domain value widens the credential to every
 * sibling subdomain. Better to refuse at boot than to debug it later.
 */
function checkRpId(rpId: string, hostname: string, problems: string[]): void {
  if (hostname === "" || rpId === hostname || hostname.endsWith(`.${rpId}`)) {
    return;
  }
  problems.push(
    `RP_ID "${rpId}" is not "${hostname}" or a parent of it, so no passkey ceremony can succeed`,
  );
}

/**
 * Better Auth reads the client IP from exactly one header and, with no trusted
 * proxy list, believes a single-valued one verbatim. On Workers that header is
 * `cf-connecting-ip`, which the edge overwrites. Everywhere else the right
 * value depends on the deployment, and guessing `x-forwarded-for` guesses
 * wrong in both directions: with no proxy the client sets it and mints itself
 * a fresh rate-limit bucket per request, and behind a proxy that appends, the
 * header arrives with two entries, resolves to nothing, and drops every caller
 * into one shared bucket that a single client can exhaust.
 */
function parseClientIpHeader(
  env: Env,
  workers: boolean,
  problems: string[],
): string {
  const configured = str(env, "CLIENT_IP_HEADER");
  if (configured !== undefined) return configured.toLowerCase();
  if (workers) return "cf-connecting-ip";
  problems.push(
    "CLIENT_IP_HEADER is required off Cloudflare: name the header your proxy " +
      "overwrites (commonly x-forwarded-for), or auth rate limiting is either " +
      "spoofable or shared by every caller",
  );
  return "";
}

export function loadConfig(env: Env, options: LoadConfigOptions = {}): Config {
  const problems: string[] = [];
  const workers = options.workers === true;

  const { secret, publicBaseUrl, baseHostname } = parseIdentity(env, problems);

  const drivers = parseDrivers(env, workers, problems);

  const limits = parseLimits(env, workers, problems);
  const s3ForcePathStyle = bool(env, "S3_FORCE_PATH_STYLE", true, problems);
  const logging = parseLogging(env, problems);
  const rpId = str(env, "RP_ID") ?? baseHostname;
  checkRpId(rpId, baseHostname, problems);
  const clientIpHeader = parseClientIpHeader(env, workers, problems);

  if (problems.length > 0) {
    throw new Error(
      `Invalid configuration:\n  - ${problems.join("\n  - ")}\n` +
        "See docs/self-hosting.md for the full environment contract.",
    );
  }
  return {
    ...drivers,
    secret,
    publicBaseUrl,
    rpId,
    rpName: str(env, "RP_NAME") ?? "BunkerPlan",
    clientIpHeader,
    ...limits,
    s3Endpoint: str(env, "S3_ENDPOINT"),
    s3Region: str(env, "S3_REGION") ?? "us-east-1",
    s3ForcePathStyle,
    ...logging,
    sqlitePath: str(env, "SQLITE_PATH") ?? "./data/bunkerplan.db",
  };
}
