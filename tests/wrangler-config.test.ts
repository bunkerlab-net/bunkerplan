import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import wrangler from "../wrangler.jsonc";

/**
 * The deployed Cloudflare configuration, checked before it ships.
 *
 * `bun run deploy` used to run a script that scanned this file for the
 * placeholder ids and the localhost base URL a fresh clone starts with. The
 * scan itself was worth little - the committed file has held real values since
 * the first deploy, so it re-read a file in git and passed every time - but
 * deleting it left nothing checking them at all.
 *
 * So these are assertions, and `bun run deploy:check` is the deploy gate that
 * runs them: the whole suite covers this on every commit, and the deploy
 * command covers it again on the way out, off one set of assertions rather
 * than a script that could drift from them.
 *
 * A localhost `PUBLIC_BASE_URL` is the sharp one: `origin` in
 * src/auth/options.ts is pinned to it and WebAuthn compares the relying-party
 * origin to the browser's exactly, so a Worker shipped with the dev value
 * serves a site where every passkey ceremony fails and no other way in exists.
 */

interface WranglerConfig {
  vars: Record<string, string | number | boolean>;
  /*
   * Optional, because the file is data and nothing validates it before this
   * cast. A block that is absent - deleted, renamed, never added - reads as
   * `undefined` at runtime whatever the type says, and declaring it required
   * would make the `?? []` guards below look like dead code while being the
   * only thing standing between a missing block and a `TypeError` that names
   * nothing.
   */
  d1_databases?: Array<{ binding: string; database_id: string }>;
  kv_namespaces?: Array<{ binding: string; id: string }>;
  r2_buckets?: Array<{ binding: string }>;
}

/** Bun's `.jsonc` loader; `Bun.file(...).json()` is strict JSON and rejects it. */
const config = wrangler as WranglerConfig;

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
function isLoopback(hostname: string): boolean {
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

describe("the deployed wrangler configuration", () => {
  test("names a real origin, not the development one", () => {
    const base = String(config.vars["PUBLIC_BASE_URL"]);

    expect(base).toStartWith("https://");
    // Shipped with any of these, WebAuthn rejects every ceremony: the
    // relying-party origin has to match the browser's exactly.
    expect(isLoopback(new URL(base).hostname)).toBe(false);
  });

  test.each([
    "localhost",
    "localhost.",
    "sub.localhost",
    "127.0.0.1",
    "127.0.0.2",
    "0x7f000001",
    "2130706433",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:127.0.0.2]",
    // Unspecified rather than loopback, and caught for the same reason.
    "0.0.0.0",
    "[::]",
  ])("%s is recognised as this machine", (host) => {
    // The predicate above is only worth as much as its coverage, and several
    // of these reach it already rewritten by `new URL()`.
    expect(isLoopback(new URL(`https://${host}/`).hostname)).toBe(true);
  });

  test.each(["plan.bunkerlab.net", "plan.bunkerlab.net.", "127x0x0x1.example"])(
    "%s is not",
    (host) => {
      expect(isLoopback(new URL(`https://${host}/`).hostname)).toBe(false);
    },
  );

  test("binds real D1 and KV ids, not the placeholder zeros", () => {
    // `?? []` so a missing block fails on the emptiness assertion below, with
    // its own message, rather than on a `TypeError` reading `.map` of
    // undefined - which says nothing about what the file was supposed to hold.
    const d1 = (config.d1_databases ?? []).map((entry) => entry.database_id);
    const kv = (config.kv_namespaces ?? []).map((entry) => entry.id);

    // Non-empty first: a missing binding block would otherwise satisfy every
    // "is not the placeholder" assertion by having nothing to compare, and a
    // Worker without `DB` or `KV` fails at runtime rather than at deploy.
    expect(d1).not.toBeEmpty();
    expect(kv).not.toBeEmpty();

    for (const id of d1) {
      // Shape as well as value: `wrangler d1 create` prints a UUID, and
      // anything else is a hand-edit that will not resolve.
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      // The id a fresh clone carries before `wrangler d1 create` is run.
      expect(id).not.toBe("00000000-0000-0000-0000-000000000000");
    }
    for (const id of kv) {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).not.toBe("0".repeat(32));
    }
  });

  /**
   * src/runtime/cloudflare.ts reaches these by name - `env.DB`, `env.KV`,
   * `env.BUCKET` - so a renamed binding is a Worker that deploys clean and
   * then fails on its first request with an undefined handle. The ids above
   * say nothing about that: they can all be real and all be bound to names
   * nothing looks for.
   */
  test("binds them under the names the runtime reaches for", () => {
    // `?? []` for the same reason the id test above uses it: a missing block
    // should fail on the name comparison, which names what is absent, rather
    // than on a `TypeError` reading `.map` of undefined.
    const names = (entries: { binding: string }[] | undefined) =>
      (entries ?? []).map((entry) => entry.binding);

    expect(names(config.d1_databases)).toEqual(["DB"]);
    expect(names(config.kv_namespaces)).toEqual(["KV"]);
    expect(names(config.r2_buckets)).toEqual(["BUCKET"]);
  });

  /**
   * The vars as the Worker will read them, through the same loader
   * src/runtime/cloudflare.ts uses. A value that parses here but not there -
   * a rate window under the floor, a plan quota above what one invocation can
   * sweep, an `RP_ID` the base URL is not under - is a deploy that boots into
   * a refusal.
   */
  test("passes the same validation the Worker runs at boot", () => {
    expect(() =>
      loadConfig(
        // The secret is set with `wrangler secret put`, so it is deliberately
        // absent from the file and supplied here to isolate the vars.
        { ...config.vars, BETTER_AUTH_SECRET: "a".repeat(32) },
        { workers: true },
      ),
    ).not.toThrow();
  });
});
