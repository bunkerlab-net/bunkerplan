import { describe, expect, test } from "bun:test";
import {
  MAX_PLAN_LABEL_LENGTH,
  parsePlanLabel,
} from "../src/http/plan-label.ts";

describe("parsePlanLabel", () => {
  test("treats absent and blank as unlabelled", () => {
    expect(parsePlanLabel(null)).toEqual({ ok: true, label: null });
    expect(parsePlanLabel("")).toEqual({ ok: true, label: null });
    expect(parsePlanLabel("   ")).toEqual({ ok: true, label: null });
  });

  test("trims the edges of a label it keeps", () => {
    expect(parsePlanLabel("  Q3 rollout  ")).toEqual({
      ok: true,
      label: "Q3 rollout",
    });
  });

  test("accepts a label at the cap and refuses one past it", () => {
    expect(parsePlanLabel("a".repeat(MAX_PLAN_LABEL_LENGTH)).ok).toBe(true);
    expect(parsePlanLabel("a".repeat(MAX_PLAN_LABEL_LENGTH + 1))).toEqual({
      ok: false,
      reason: `label exceeds ${MAX_PLAN_LABEL_LENGTH} characters`,
    });
  });

  /**
   * A NUL reached a Postgres `text` column and threw `22021`, which surfaced
   * as a 500 rather than a 400 - and SQLite stored the same value happily, so
   * the two supported runtimes disagreed about whether the request was valid.
   */
  test.each([
    ["nul", "before\u0000after"],
    ["bell", "ding\u0007"],
    ["escape", "\u001bbold"],
    ["delete", "gone\u007f"],
    ["right-to-left override", "invoice\u202egnp.exe"],
    ["left-to-right override", "a\u202db"],
    ["right-to-left isolate", "a\u2067b"],
    ["pop directional isolate", "a\u2069b"],
    ["right-to-left mark", "a\u200fb"],
    ["arabic letter mark", "a\u061cb"],
  ])("refuses a label containing a %s", (_name, label) => {
    expect(parsePlanLabel(label)).toEqual({
      ok: false,
      reason: "label contains control or text-direction characters",
    });
  });

  /**
   * The joiner is a format character too, but taking all of `\p{Cf}` would
   * break ordinary emoji and several scripts, so it stays allowed.
   */
  test.each([
    ["a family emoji", "family 👨\u200d👩\u200d👧"],
    ["plain emoji", "ship it 🚀"],
    ["accented latin", "Café plan"],
    ["arabic", "خطة"],
    ["japanese", "計画"],
    ["punctuation", "Q3 — rollout (final): v2!"],
  ])("keeps %s", (_name, label) => {
    expect(parsePlanLabel(label)).toEqual({ ok: true, label });
  });

  test("measures the cap after trimming, not before", () => {
    const padded = `  ${"a".repeat(MAX_PLAN_LABEL_LENGTH)}  `;
    expect(parsePlanLabel(padded).ok).toBe(true);
  });
});
