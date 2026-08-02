/**
 * The environments the two configuration suites are written against.
 *
 * Shared because they had drifted: `CLIENT_IP_HEADER` was present in one copy
 * and absent from the other, so "the minimum a deployment must supply" meant
 * two different things depending on which file you read.
 *
 * Which suite owns what:
 *
 * - tests/config.test.ts covers the settings whose *values* are
 *   security-relevant - the client IP header, the relying-party id, and the
 *   two id lengths. It uses these environments as they are, because the header
 *   being absent is exactly what several of its cases are about.
 * - tests/config-validation.test.ts covers the shape of the contract: every
 *   driver's companion setting, every parser's refusal, and the combined
 *   report. It adds `CLIENT_IP_HEADER` to both, because a missing one would
 *   otherwise be a second complaint in every message it asserts on.
 */

/**
 * The two settings no deployment can omit, on any runtime.
 *
 * Frozen: every suite here spreads these into a local object, and one that
 * wrote onto the shared one instead would change what "the minimum" means for
 * every file after it, in whatever order they happened to run.
 */
export const REQUIRED = Object.freeze({
  BETTER_AUTH_SECRET: "x".repeat(32),
  /*
   * The hostname matters, not just the shape. tests/config.test.ts derives the
   * default `RP_ID` from it and checks that `notexample.com` is refused as a
   * suffix match against `example.com`, so a value without a registrable
   * parent domain would make those cases assert nothing.
   */
  PUBLIC_BASE_URL: "https://plans.example.com",
});

/** The driver set a self-hosted deployment must supply on top of those. */
export const SELF_HOSTED = Object.freeze({
  ...REQUIRED,
  STORAGE_DRIVER: "s3",
  S3_BUCKET: "plans",
  DB_DRIVER: "postgres",
  DATABASE_URL: "postgres://localhost/plans",
  KV_DRIVER: "valkey",
  VALKEY_URL: "redis://localhost:6379",
});

/**
 * A header off Workers, where the loader refuses to guess one. Deliberately
 * not folded into the two above: tests/config.test.ts asserts that refusal.
 */
export const CLIENT_IP_HEADER = Object.freeze({
  CLIENT_IP_HEADER: "x-forwarded-for",
});
