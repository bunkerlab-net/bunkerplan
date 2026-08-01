import { describe, expect, test } from "bun:test";
import { parseVisibility } from "../src/http/plan-visibility.ts";

/**
 * One parser for both readers of the setting, with the differences named at
 * the call rather than baked into two functions: the upload route takes a
 * query parameter and allows `code`; the sharing route takes a JSON body,
 * refuses `code`, and refuses an absent value instead of defaulting.
 */
const upload = { code: true, absent: "private", from: "value" } as const;
const sharing = { code: false, absent: "refuse", from: "body" } as const;

describe("the upload parameter", () => {
  test("an absent parameter means private", () => {
    // The default is the whole point of the feature: a client that predates
    // it, and sends no parameter at all, must not publish anything.
    expect(parseVisibility(null, upload)).toEqual({
      ok: true,
      requested: "private",
      stored: "private",
    });
  });

  test.each(["public", "private"] as const)("accepts %s", (requested) => {
    expect(parseVisibility(requested, upload)).toEqual({
      ok: true,
      requested,
      stored: requested,
    });
  });

  test("code is an intent, not a stored state", () => {
    // The column holds two values. A third leaking in would reach the
    // dashboard, the API document, and the read gate's comparison - so the
    // parser reports what was asked for and what is written separately.
    expect(parseVisibility("code", upload)).toEqual({
      ok: true,
      requested: "code",
      stored: "private",
    });
  });

  test.each([
    ["an unknown word", "unlisted"],
    ["the empty string", ""],
    ["a near miss in case", "Public"],
    ["whitespace around a valid value", " public "],
  ])("refuses %s", (_, raw) => {
    expect(parseVisibility(raw, upload)).toEqual({
      ok: false,
      reason: "visibility must be public, private, or code",
    });
  });
});

describe("the sharing body", () => {
  test.each(["public", "private"] as const)("accepts %s", (visibility) => {
    expect(parseVisibility({ visibility }, sharing)).toEqual({
      ok: true,
      requested: visibility,
      stored: visibility,
    });
  });

  test("refuses code, which is an upload intent", () => {
    // Giving an existing plan a code is POST /share-code, because that is the
    // request that hands back a plaintext.
    expect(parseVisibility({ visibility: "code" }, sharing)).toEqual({
      ok: false,
      reason: "visibility must be public or private",
    });
  });

  test.each([
    ["no visibility key at all", {}],
    ["an explicit null", { visibility: null }],
    ["a number", { visibility: 1 }],
    ["a nested object", { visibility: { visibility: "public" } }],
    ["a boolean", { visibility: true }],
  ])("refuses %s", (_, raw) => {
    expect(parseVisibility(raw, sharing)).toEqual({
      ok: false,
      reason: "visibility must be public or private",
    });
  });

  test("refuses a bare JSON string, which is not a body with a field", () => {
    // `from: "body"` digs the field out itself rather than being handed it, so
    // a body that happens to be the right word is still the wrong shape.
    expect(parseVisibility("public", sharing)).toEqual({
      ok: false,
      reason: "visibility must be public or private",
    });
  });
});
