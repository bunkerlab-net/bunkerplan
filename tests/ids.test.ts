import { describe, expect, test } from "bun:test";
import { isPlanId, newPlanId, newUserHandle } from "../src/ids.ts";

const SAMPLE = 500;

describe("newPlanId", () => {
  test("is lowercase alphanumeric only, never - or _", () => {
    for (let i = 0; i < SAMPLE; i += 1) {
      expect(newPlanId(16)).toMatch(/^[0-9a-z]{16}$/);
    }
  });

  test("honours the requested length", () => {
    for (const length of [8, 12, 16, 32]) {
      expect(newPlanId(length)).toHaveLength(length);
    }
  });

  test("does not repeat within a sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < SAMPLE; i += 1) seen.add(newPlanId(16));
    expect(seen.size).toBe(SAMPLE);
  });
});

describe("isPlanId", () => {
  test("accepts everything newPlanId produces", () => {
    for (const length of [8, 12, 16, 32, 63]) {
      for (let i = 0; i < 50; i += 1) {
        expect(isPlanId(newPlanId(length))).toBe(true);
      }
    }
  });

  /**
   * The lowercase rule is what keeps `{id}.{host}` reachable later without
   * re-encoding: DNS labels are case-insensitive and the URL parser lowercases
   * a host, so an uppercase id could not survive the move. Refusing it here
   * means no id can be minted, stored, or served that would not fit.
   */
  test("rejects uppercase, so every id is also a valid DNS label", () => {
    expect(isPlanId("AbCd1234")).toBe(false);
    expect(isPlanId(newPlanId(16).toUpperCase())).toBe(false);
  });

  /**
   * The other half of the same invariant. `MAX_PLAN_ID_LENGTH` stops a longer
   * id being minted; this stops one being served or addressed if it arrives
   * from anywhere else.
   */
  test("rejects an id longer than a DNS label holds", () => {
    expect(isPlanId("a".repeat(63))).toBe(true);
    expect(isPlanId("a".repeat(64))).toBe(false);
  });

  /**
   * The public route hands this value to the object store as a key, and the
   * router percent-decodes it first. Each of these would otherwise address
   * something that is not a plan.
   */
  test("rejects anything that could address another object", () => {
    for (const value of [
      "",
      "config.json",
      "backups/db.sql",
      "../../etc/passwd",
      "plans/other",
      "/leading",
      "trailing/",
      "has space",
      "has\u0000nul",
      "dash-id",
      "under_score",
      "a".repeat(64),
    ]) {
      expect(isPlanId(value)).toBe(false);
    }
  });

  test("is anchored, so a valid id embedded in junk is still refused", () => {
    const id = newPlanId(16);
    expect(isPlanId(`${id}/../secret`)).toBe(false);
    expect(isPlanId(`prefix/${id}`)).toBe(false);
    expect(isPlanId(`${id}\n`)).toBe(false);
  });
});

describe("newUserHandle", () => {
  test("avoids - and _ and lookalike characters", () => {
    for (let i = 0; i < SAMPLE; i += 1) {
      expect(newUserHandle()).toMatch(
        /^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/,
      );
    }
  });
});
