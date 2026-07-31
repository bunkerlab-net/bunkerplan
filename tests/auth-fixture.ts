/**
 * The configuration `buildAuthOptions` is exercised with.
 *
 * Shared because two suites read the same options object from two angles -
 * auth-options.test.ts checks the wiring it produces, auth-registration.test.ts
 * checks the passkey plugin inside it - and a fixture that drifted between them
 * would have each proving something about a deployment the other never sees.
 *
 * `database: undefined` is deliberate: `betterAuth()` needs one, but the
 * options object handed to it does not, and that object is what both suites
 * are about.
 */
export const BASE = Object.freeze({
  database: undefined,
  baseURL: "https://plans.example.test",
  secret: "x".repeat(32),
  rpId: "plans.example.test",
  rpName: "BunkerPlan",
  clientIpHeader: "cf-connecting-ip",
});
