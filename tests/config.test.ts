import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const REQUIRED = {
  BETTER_AUTH_SECRET: "x".repeat(32),
  PUBLIC_BASE_URL: "https://plans.example.com",
};

/** The driver set a self-hosted deployment must supply. */
const SELF_HOSTED = {
  ...REQUIRED,
  STORAGE_DRIVER: "s3",
  S3_BUCKET: "plans",
  DB_DRIVER: "postgres",
  DATABASE_URL: "postgres://localhost/plans",
  KV_DRIVER: "valkey",
  VALKEY_URL: "redis://localhost:6379",
};

/**
 * Better Auth keys its rate limit on the client IP. When it cannot resolve
 * one, every caller collapses into a single bucket per path and the shared
 * 100-per-60s ceiling 429s everybody. Workers puts the address in
 * `cf-connecting-ip`, which is not the header Better Auth reads by default.
 */
describe("clientIpHeader", () => {
  test("is the Cloudflare header on Workers", () => {
    expect(loadConfig(REQUIRED, { workers: true }).clientIpHeader).toBe(
      "cf-connecting-ip",
    );
  });

  /**
   * There is no safe default off Workers. Guessing `x-forwarded-for` is wrong
   * in both directions: with no proxy in front, the client sets it and mints
   * itself a fresh bucket per request; behind a proxy that appends, it arrives
   * with two entries, resolves to nothing, and drops every caller into one
   * shared bucket a single client can exhaust. So it must be stated.
   */
  test("refuses to boot off Workers without an explicit header", () => {
    expect(() => loadConfig(SELF_HOSTED)).toThrow(
      /CLIENT_IP_HEADER is required/,
    );
  });

  test("boots off Workers once the header is named", () => {
    const config = loadConfig({
      ...SELF_HOSTED,
      CLIENT_IP_HEADER: "x-forwarded-for",
    });
    expect(config.clientIpHeader).toBe("x-forwarded-for");
  });

  test("an explicit header wins over the runtime default", () => {
    const env = { ...REQUIRED, CLIENT_IP_HEADER: "x-real-ip" };
    expect(loadConfig(env, { workers: true }).clientIpHeader).toBe("x-real-ip");
  });

  test("is lowercased so a plain header object still matches", () => {
    const env = { ...REQUIRED, CLIENT_IP_HEADER: "CF-Connecting-IP" };
    expect(loadConfig(env, { workers: true }).clientIpHeader).toBe(
      "cf-connecting-ip",
    );
  });
});

/**
 * A passkey is scoped to the relying-party id. A value the served hostname is
 * neither equal to nor a subdomain of cannot produce a working ceremony, and
 * the browser reports it only as an opaque failure.
 */
describe("rpId", () => {
  test("defaults to the hostname of the public base URL", () => {
    expect(loadConfig(REQUIRED, { workers: true }).rpId).toBe(
      "plans.example.com",
    );
  });

  test("accepts a parent domain of the served hostname", () => {
    const env = { ...REQUIRED, RP_ID: "example.com" };
    expect(loadConfig(env, { workers: true }).rpId).toBe("example.com");
  });

  test("accepts the exact hostname", () => {
    const env = { ...REQUIRED, RP_ID: "plans.example.com" };
    expect(loadConfig(env, { workers: true }).rpId).toBe("plans.example.com");
  });

  test("refuses a value the hostname is not under", () => {
    const env = { ...REQUIRED, RP_ID: "elsewhere.test" };
    expect(() => loadConfig(env, { workers: true })).toThrow(/RP_ID/);
  });

  /** A suffix match is not enough: `notexample.com` must not pass for it. */
  test("refuses a value that is only a string suffix", () => {
    const env = {
      ...REQUIRED,
      PUBLIC_BASE_URL: "https://notexample.com",
      RP_ID: "example.com",
    };
    expect(() => loadConfig(env, { workers: true })).toThrow(/RP_ID/);
  });
});

/**
 * `vars` in wrangler.jsonc is JSON, so `"UPLOAD_RATE_MAX": 30` unquoted
 * reaches the Worker as a number. Requiring a string made the Worker runtime
 * drop it, which looked like configuration but silently kept the default.
 */
describe("non-string environment values", () => {
  test("a numeric var is honoured, not ignored", () => {
    const config = loadConfig(
      { ...REQUIRED, UPLOAD_RATE_MAX: 100, UPLOAD_RATE_WINDOW_SEC: 120 },
      { workers: true },
    );
    expect(config.uploadRateMax).toBe(100);
    expect(config.uploadRateWindowSec).toBe(120);
  });

  test("a boolean var is honoured", () => {
    const config = loadConfig(
      { ...REQUIRED, LOG_COLOR: true },
      { workers: true },
    );
    expect(config.logColor).toBe(true);
  });

  test("a quoted number still works", () => {
    const config = loadConfig(
      { ...REQUIRED, UPLOAD_RATE_MAX: "100" },
      { workers: true },
    );
    expect(config.uploadRateMax).toBe(100);
  });
});

/**
 * Plan ids are lowercase (src/ids.ts) so that one is also a valid DNS label,
 * which is what keeps a later move to `{id}.{host}` a redirect rather than a
 * re-encoding of every published URL. A configurable length with no ceiling
 * would undo that quietly: the ids would still be lowercase and still be
 * unmintable as hostnames.
 */
describe("planIdLength", () => {
  test("accepts the longest id a DNS label can hold", () => {
    const config = loadConfig(
      { ...REQUIRED, PLAN_ID_LENGTH: 63 },
      { workers: true },
    );
    expect(config.planIdLength).toBe(63);
  });

  test("refuses to boot on a length no hostname could carry", () => {
    expect(() =>
      loadConfig({ ...REQUIRED, PLAN_ID_LENGTH: 64 }, { workers: true }),
    ).toThrow(/PLAN_ID_LENGTH must be an integer between 8 and 63/);
  });

  test("refuses to boot on a length too short to resist guessing", () => {
    expect(() =>
      loadConfig({ ...REQUIRED, PLAN_ID_LENGTH: 7 }, { workers: true }),
    ).toThrow(/PLAN_ID_LENGTH must be an integer between 8 and 63/);
  });

  test("defaults to 16 when unset", () => {
    expect(loadConfig(REQUIRED, { workers: true }).planIdLength).toBe(16);
  });
});
