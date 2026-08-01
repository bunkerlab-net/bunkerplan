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
  d1_databases: Array<{ binding: string; database_id: string }>;
  kv_namespaces: Array<{ binding: string; id: string }>;
  r2_buckets: Array<{ binding: string }>;
}

/** Bun's `.jsonc` loader; `Bun.file(...).json()` is strict JSON and rejects it. */
const config = wrangler as WranglerConfig;

describe("the deployed wrangler configuration", () => {
  test("names a real origin, not the development one", () => {
    const base = String(config.vars["PUBLIC_BASE_URL"]);
    expect(base).toStartWith("https://");

    // Every spelling of "this machine", not just the word. `127.0.0.1`,
    // `[::1]`, and the reserved `.localhost` suffix all resolve to the
    // loopback, and any of them shipped would break WebAuthn exactly as
    // `localhost` does - the relying-party origin has to match the browser's.
    const { hostname } = new URL(base);
    expect(hostname).not.toBe("localhost");
    expect(hostname).not.toEndWith(".localhost");
    expect(hostname).not.toBe("127.0.0.1");
    expect(hostname).not.toBe("[::1]");
  });

  test("binds real D1 and KV ids, not the placeholder zeros", () => {
    const d1 = config.d1_databases.map((entry) => entry.database_id);
    const kv = config.kv_namespaces.map((entry) => entry.id);

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
    expect(config.d1_databases.map((entry) => entry.binding)).toEqual(["DB"]);
    expect(config.kv_namespaces.map((entry) => entry.binding)).toEqual(["KV"]);
    expect(config.r2_buckets.map((entry) => entry.binding)).toEqual(["BUCKET"]);
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
