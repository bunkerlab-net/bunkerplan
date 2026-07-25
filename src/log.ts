import ecsFormat from "@elastic/ecs-pino-format";
import { type Logger, pino } from "pino";
import { prettyFactory } from "pino-pretty";
import type { Config } from "./config.ts";

export type { Logger };

const CENSOR = "[redacted]";

/**
 * Key paths whose values are censored by pino's `redact`.
 *
 * Explicit keys cost about 2% over `JSON.stringify`; each wildcard tier is far
 * more expensive, so this stays at one level of nesting rather than `**`.
 * Paths are case sensitive, hence the duplicated casings.
 */
const REDACT_PATHS = [
  "password",
  "*.password",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "authorization",
  "*.authorization",
  "connectionString",
  "*.connectionString",
  "accessKeyId",
  "*.accessKeyId",
  "secretAccessKey",
  "*.secretAccessKey",
];

/**
 * Strips inline credentials from connection URLs.
 *
 * `redact` cannot do this. It censors values at key paths, and the credential
 * we actually leak arrives as a substring: a failing `pg` or `ioredis` driver
 * puts the whole connection URL inside `error.message`, where no path points
 * at it.
 *
 * The entire userinfo goes, username included. A password may legitimately
 * contain `:` and, when a driver echoes unencoded input, `@` as well, so the
 * user/password boundary cannot be located reliably. Matching greedily to the
 * last `@` before the path and censoring all of it is the only version with no
 * parse ambiguity to leak through. The host and port survive, which is what
 * makes a connection failure diagnosable.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/gi;

export function redactSecrets(line: string): string {
  return line.replace(URL_USERINFO, `$1${CENSOR}@`);
}

/**
 * One logger for both runtimes.
 *
 * Output goes through `console` rather than pino's default stdout destination.
 * That is required on Cloudflare Workers, where the platform ingests console
 * output and pino's `sonic-boom`/`thread-stream` destinations have no files or
 * worker threads to write to. Under Node and Bun, `console.log` still writes to
 * stdout, so Docker and journald collect it as usual.
 *
 * `pino-pretty` is used through `prettyFactory`, its pure string formatter,
 * for the same reason: as a stream it either throws on workerd or silently
 * buffers and drops every line.
 *
 * Sanitising in the destination rather than at each call site is deliberate.
 * Both formats funnel through here, so a log added later cannot forget it.
 */
export function createLogger(config: Config): Logger {
  const level = config.logLevel;
  const redact = { paths: REDACT_PATHS, censor: CENSOR };

  if (config.logFormat === "plain") {
    const prettify = prettyFactory({ colorize: config.logColor });
    return pino(
      { level, redact },
      {
        write(line: string) {
          console.log(redactSecrets(prettify(line)).trimEnd());
        },
      },
    );
  }

  return pino(
    { ...ecsFormat(), level, redact },
    {
      write(line: string) {
        console.log(redactSecrets(line).trimEnd());
      },
    },
  );
}
