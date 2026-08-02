import { loadConfig } from "../src/config.ts";
import wrangler from "../wrangler.jsonc";

/**
 * The deployed Cloudflare configuration, checked before it ships.
 *
 * This is a script rather than a test because of where it runs: the deploy job
 * calls it before applying D1 migrations, and `bun test` carries the coverage
 * threshold in bunfig.toml on every invocation. A one-file test run cannot
 * meet a whole-project threshold, so a gate built on `bun test` fails for a
 * reason that has nothing to do with the configuration it is checking - which
 * is exactly what broke the deploy of #30.
 *
 * The checks are exported rather than inlined so tests/wrangler-config.test.ts
 * asserts these same functions, against the real file and against synthetic
 * bad ones. A gate that only ever sees a good config never proves it can
 * refuse a bad one.
 */

export interface WranglerConfig {
  /*
   * All optional, because the file is data and nothing validates it before
   * this runs: a block deleted by hand is exactly the mistake worth catching,
   * and typing one as present would make that a `TypeError` here instead of a
   * named problem - which is the one thing this must not do, since a throw
   * reports the first fault and hides the rest.
   */
  vars?: Record<string, string | number | boolean>;
  d1_databases?: Array<{ binding: string; database_id: string }>;
  kv_namespaces?: Array<{ binding: string; id: string }>;
  r2_buckets?: Array<{ binding: string }>;
}

/**
 * Whether a hostname names this machine, in any of the spellings a URL keeps.
 *
 * A predicate rather than a list of literals, because the list was never
 * finishable: the whole of `127.0.0.0/8` is loopback, so `127.0.0.2` is as
 * local as `127.0.0.1`, and each has an IPv4-mapped IPv6 form that `new URL()`
 * canonicalises to hex - `[::ffff:127.0.0.2]` becomes `[::ffff:7f00:2]`. The
 * `7f` prefix after `::ffff:` is that first octet, so it covers the range.
 *
 * The trailing dot goes first: a fully qualified `localhost.` is the same host
 * and `new URL()` keeps the dot, where it normalises the IPv4 forms for us -
 * `0x7f000001` and `2130706433` both arrive as `127.0.0.1` already.
 *
 * `0.0.0.0` and `::` are here too, though neither is loopback in the strict
 * sense - they are the unspecified addresses, which name every interface
 * rather than one. As a `PUBLIC_BASE_URL` they are the same mistake with the
 * same consequence: not a name a browser can reach the deployment by, so the
 * WebAuthn relying-party origin would never match and every ceremony would
 * fail. What this guards is "did a development value ship", and those two are
 * development values.
 */
export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "::" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^::ffff:7f/i.test(host)
  );
}

/** The id a fresh clone carries before `wrangler d1 create` is run. */
const PLACEHOLDER_D1 = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_KV = "0".repeat(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KV_ID = /^[0-9a-f]{32}$/;

/**
 * The base URL a browser has to reach the deployment by.
 *
 * Shipped as loopback, WebAuthn rejects every ceremony: the relying-party
 * origin has to match the browser's exactly.
 */
function baseUrlProblems(vars: WranglerConfig["vars"]): string[] {
  const base = String(vars?.["PUBLIC_BASE_URL"] ?? "");

  if (!base.startsWith("https://")) {
    return [`PUBLIC_BASE_URL is not https: ${base || "(unset)"}`];
  }

  // `https://[` passes the prefix check and throws here. Reported rather than
  // raised, so a hand-edited file still gets told everything else wrong with
  // it in the same run.
  let hostname: string;
  try {
    hostname = new URL(base).hostname;
  } catch {
    return [`PUBLIC_BASE_URL is not a URL: ${base}`];
  }

  return isLoopback(hostname)
    ? [`PUBLIC_BASE_URL names this machine, not the site: ${base}`]
    : [];
}

/**
 * The ids, by shape and by value.
 *
 * `?? []` so a missing block fails on the emptiness check, with its own
 * message, rather than on a `TypeError` reading `.map` of undefined - which
 * says nothing about what the file was supposed to hold. Non-empty first: a
 * missing block would otherwise satisfy every "is not the placeholder" check
 * by having nothing to compare, and a Worker without `DB` or `KV` fails at
 * runtime rather than at deploy.
 */
function idProblems(config: WranglerConfig): string[] {
  const problems: string[] = [];
  const d1 = config.d1_databases ?? [];
  const kv = config.kv_namespaces ?? [];

  if (d1.length === 0) problems.push("no d1_databases are bound");
  if (kv.length === 0) problems.push("no kv_namespaces are bound");

  for (const { database_id: id } of d1) {
    // Shape as well as value: `wrangler d1 create` prints a UUID, and anything
    // else is a hand-edit that will not resolve.
    if (!UUID.test(id)) problems.push(`D1 id is not a uuid: ${id}`);
    else if (id === PLACEHOLDER_D1) problems.push("D1 id is the placeholder");
  }
  for (const { id } of kv) {
    if (!KV_ID.test(id)) problems.push(`KV id is not a namespace id: ${id}`);
    else if (id === PLACEHOLDER_KV) problems.push("KV id is the placeholder");
  }
  return problems;
}

/**
 * The names src/runtime/cloudflare.ts reaches for - `env.DB`, `env.KV`,
 * `env.BUCKET`. A renamed binding is a Worker that deploys clean and then
 * fails on its first request with an undefined handle. The ids say nothing
 * about that: they can all be real and all be bound to names nothing looks for.
 */
function bindingNameProblems(config: WranglerConfig): string[] {
  const wanted: Array<[{ binding: string }[] | undefined, string]> = [
    [config.d1_databases, "DB"],
    [config.kv_namespaces, "KV"],
    [config.r2_buckets, "BUCKET"],
  ];

  return wanted.flatMap(([entries, want]) => {
    const bindings = (entries ?? []).map((entry) => entry.binding);
    return bindings.length === 1 && bindings[0] === want
      ? []
      : [`expected one binding named ${want}, got [${bindings}]`];
  });
}

/**
 * The vars as the Worker will read them, through the same loader
 * src/runtime/cloudflare.ts uses. A value that parses here but not there - a
 * rate window under the floor, a plan quota above what one invocation can
 * sweep, an `RP_ID` the base URL is not under - is a deploy that boots into a
 * refusal.
 */
function varsProblems(vars: WranglerConfig["vars"]): string[] {
  try {
    loadConfig(
      // The secret is set with `wrangler secret put`, so it is deliberately
      // absent from the file and supplied here to isolate the vars.
      { ...vars, BETTER_AUTH_SECRET: "a".repeat(32) },
      { workers: true },
    );
    return [];
  } catch (cause) {
    return [`vars fail the Worker's own validation: ${String(cause)}`];
  }
}

/**
 * Every reason this configuration should not ship, named.
 *
 * A list rather than a throw, so one run reports all of them: a fresh clone
 * has the placeholder ids *and* the localhost base URL, and fixing them one
 * deploy at a time is three failed deploys.
 */
export function deployConfigProblems(config: WranglerConfig): string[] {
  return [
    ...baseUrlProblems(config.vars),
    ...idProblems(config),
    ...bindingNameProblems(config),
    ...varsProblems(config.vars),
  ];
}

if (import.meta.main) {
  const problems = deployConfigProblems(wrangler as WranglerConfig);
  for (const problem of problems) console.error(`wrangler.jsonc: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log("wrangler.jsonc is deployable");
}
