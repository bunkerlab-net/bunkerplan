import { describe, expect, test } from "bun:test";
import { isPlanId, newPlanId, newUserHandle } from "../src/ids.ts";

const SAMPLE = 500;

describe("newPlanId", () => {
  test("is alphanumeric only, never - or _", () => {
    for (let i = 0; i < SAMPLE; i += 1) {
      expect(newPlanId(16)).toMatch(/^[0-9A-Za-z]{16}$/);
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
    for (const length of [8, 12, 16, 32, 64]) {
      for (let i = 0; i < 50; i += 1) {
        expect(isPlanId(newPlanId(length))).toBe(true);
      }
    }
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
      "a".repeat(65),
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
