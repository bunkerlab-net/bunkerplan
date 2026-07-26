/**
 * Environment parsing. The variable names below are the self-hosting API —
 * see docs/self-hosting.md. Renaming one is a breaking change for operators.
 *
 * Every problem is collected and reported in a single Error so a misconfigured
 * container fails loudly at boot instead of on the first request.
 */

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
  uploadRateMax: number;
  uploadRateWindowSec: number;
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

const MIN_SECRET_LENGTH = 32;
/** Workers KV rejects `expirationTtl` below 60 seconds. */
const MIN_RATE_WINDOW_SEC = 60;
const DEFAULT_MAX_UPLOAD_BYTES = 2_097_152;
const DEFAULT_PLAN_ID_LENGTH = 16;
/**
 * Plan URLs are public and unlisted, so the id is the only thing keeping a
 * document from being found by guessing. Eight alphanumeric characters is
 * about 48 bits, which is the floor worth allowing.
 */
const MIN_PLAN_ID_LENGTH = 8;

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
): number {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    problems.push(`${key} must be an integer >= ${min}, got "${raw}"`);
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
  const storageDriver = oneOf(
    env,
    "STORAGE_DRIVER",
    ["r2", "s3"] as const,
    workers ? "r2" : undefined,
    problems,
  );
  const s3Bucket = str(env, "S3_BUCKET");
  if (storageDriver === "s3" && s3Bucket === undefined) {
    problems.push("S3_BUCKET is required when STORAGE_DRIVER=s3");
  }
  const s3AccessKeyId = str(env, "S3_ACCESS_KEY_ID");
  const s3SecretAccessKey = str(env, "S3_SECRET_ACCESS_KEY");
  // Half-configured is rejected rather than silently falling through to the
  // provider chain — that failure mode surfaces as a confusing 403 much later.
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

  const dbDriver = oneOf(
    env,
    "DB_DRIVER",
    ["d1", "sqlite", "postgres"] as const,
    workers ? "d1" : undefined,
    problems,
  );
  const databaseUrl = str(env, "DATABASE_URL");
  if (dbDriver === "postgres" && databaseUrl === undefined) {
    problems.push("DATABASE_URL is required when DB_DRIVER=postgres");
  }

  const kvDriver = oneOf(
    env,
    "KV_DRIVER",
    ["kv", "valkey"] as const,
    workers ? "kv" : undefined,
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
  uploadRateMax: number;
  uploadRateWindowSec: number;
}

function parseLimits(env: Env, problems: string[]): Limits {
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
    ),
    uploadRateMax: int(env, "UPLOAD_RATE_MAX", 30, 1, problems),
    uploadRateWindowSec: Math.max(
      MIN_RATE_WINDOW_SEC,
      int(env, "UPLOAD_RATE_WINDOW_SEC", MIN_RATE_WINDOW_SEC, 1, problems),
    ),
  };
}

export function loadConfig(env: Env, options: LoadConfigOptions = {}): Config {
  const problems: string[] = [];
  const workers = options.workers === true;

  const { secret, publicBaseUrl, baseHostname } = parseIdentity(env, problems);

  const drivers = parseDrivers(env, workers, problems);

  const limits = parseLimits(env, problems);
  const s3ForcePathStyle = bool(env, "S3_FORCE_PATH_STYLE", true, problems);
  const logging = parseLogging(env, problems);

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
    rpId: str(env, "RP_ID") ?? baseHostname,
    rpName: str(env, "RP_NAME") ?? "BunkerPlan",
    // Cloudflare overwrites `cf-connecting-ip` at the Worker, so it cannot be
    // spoofed there; elsewhere Better Auth's own `x-forwarded-for` default
    // applies. See CLIENT_IP_HEADER in docs/self-hosting.md.
    clientIpHeader: (
      str(env, "CLIENT_IP_HEADER") ??
      (workers ? "cf-connecting-ip" : "x-forwarded-for")
    ).toLowerCase(),
    ...limits,
    s3Endpoint: str(env, "S3_ENDPOINT"),
    s3Region: str(env, "S3_REGION") ?? "us-east-1",
    s3ForcePathStyle,
    ...logging,
    sqlitePath: str(env, "SQLITE_PATH") ?? "./data/bunkerplan.db",
  };
}
