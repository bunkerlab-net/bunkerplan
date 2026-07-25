import { describe, expect, test } from "bun:test";
import { newPlanId, newUserHandle } from "../src/ids.ts";

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

describe("newUserHandle", () => {
  test("avoids - and _ and lookalike characters", () => {
    for (let i = 0; i < SAMPLE; i += 1) {
      expect(newUserHandle()).toMatch(
        /^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/,
      );
    }
  });
});
