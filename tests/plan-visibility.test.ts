import { describe, expect, test } from "bun:test";
import {
  parsePlanVisibility,
  parseUploadVisibility,
  storedVisibility,
} from "../src/http/plan-visibility.ts";

describe("parseUploadVisibility", () => {
  test("an absent parameter means private", () => {
    // The default is the whole point of the feature: a client that predates
    // it, and sends no parameter at all, must not publish anything.
    expect(parseUploadVisibility(null)).toEqual({
      ok: true,
      requested: "private",
    });
  });

  test.each(["public", "private", "code"] as const)(
    "accepts %s",
    (requested) => {
      expect(parseUploadVisibility(requested)).toEqual({ ok: true, requested });
    },
  );

  test.each([
    ["an unknown word", "unlisted"],
    ["the empty string", ""],
    ["a near miss in case", "Public"],
    ["whitespace around a valid value", " public "],
  ])("refuses %s", (_, raw) => {
    expect(parseUploadVisibility(raw)).toEqual({
      ok: false,
      reason: "visibility must be public, private, or code",
    });
  });
});

describe("storedVisibility", () => {
  test("code is an intent, not a stored state", () => {
    // The column holds two values. A third leaking in would reach the
    // dashboard, the API document, and the read gate's comparison.
    expect(storedVisibility("code")).toBe("private");
    expect(storedVisibility("private")).toBe("private");
    expect(storedVisibility("public")).toBe("public");
  });
});

describe("parsePlanVisibility", () => {
  test.each(["public", "private"] as const)("accepts %s", (visibility) => {
    expect(parsePlanVisibility(visibility)).toEqual({ ok: true, visibility });
  });

  test("refuses code, which is an upload intent", () => {
    // Giving an existing plan a code is POST /share-code, because that is the
    // request that hands back a plaintext.
    expect(parsePlanVisibility("code")).toEqual({
      ok: false,
      reason: "visibility must be public or private",
    });
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
    ["an object", { visibility: "public" }],
    ["a boolean", true],
  ])("refuses %s from a JSON body", (_, raw) => {
    expect(parsePlanVisibility(raw)).toEqual({
      ok: false,
      reason: "visibility must be public or private",
    });
  });
});
