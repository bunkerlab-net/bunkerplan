import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const REQUIRED = {
  BETTER_AUTH_SECRET: "x".repeat(32),
  PUBLIC_BASE_URL: "https://plans.example.com",
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

  test("falls back to the forwarded header off Workers", () => {
    const config = loadConfig({
      ...REQUIRED,
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "plans",
      DB_DRIVER: "postgres",
      DATABASE_URL: "postgres://localhost/plans",
      KV_DRIVER: "valkey",
      VALKEY_URL: "redis://localhost:6379",
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
