import { describe, expect, test } from "bun:test";
import {
  MAX_PLAN_LABEL_LENGTH,
  parsePlanLabel,
} from "../src/http/plan-label.ts";
import { relabelPlan } from "../src/http/relabel-plan.ts";
import type { PlanRepo } from "../src/services/types.ts";

const OWNER = "user-a";
const OTHER = "user-b";
const ID = "plan-1";

/** Only the owner's row exists; `relabel` enforces that, as the real one does. */
function fakes() {
  const stored: { label: string | null } = { label: null };

  const plans: PlanRepo = {
    insert: async () => true,
    listByUser: async () => [],
    findOwner: async () => OWNER,
    relabel: async (id, userId, label) => {
      if (id !== ID || userId !== OWNER) return false;
      stored.label = label;
      return true;
    },
    resize: async () => false,
    deleteOwned: async () => false,
  };

  return { plans, stored };
}

function patch(body: unknown): Request {
  return new Request("https://example.test/api/plans/plan-1", {
    method: "PATCH",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("parsePlanLabel", () => {
  test("an absent label is not a label", () => {
    expect(parsePlanLabel(null)).toEqual({ ok: true, label: null });
  });

  test("blank clears rather than storing whitespace", () => {
    expect(parsePlanLabel("   ")).toEqual({ ok: true, label: null });
  });

  test("trims the surrounding space", () => {
    expect(parsePlanLabel("  Q3 rollout \n")).toEqual({
      ok: true,
      label: "Q3 rollout",
    });
  });

  test("accepts exactly the maximum length", () => {
    const label = "x".repeat(MAX_PLAN_LABEL_LENGTH);
    expect(parsePlanLabel(label)).toEqual({ ok: true, label });
  });

  test("refuses one character past the maximum", () => {
    const result = parsePlanLabel("x".repeat(MAX_PLAN_LABEL_LENGTH + 1));
    expect(result.ok).toBe(false);
  });

  test("length is measured after trimming", () => {
    const label = "x".repeat(MAX_PLAN_LABEL_LENGTH);
    expect(parsePlanLabel(`   ${label}   `)).toEqual({ ok: true, label });
  });
});

describe("relabelPlan", () => {
  test("stores a trimmed label and echoes it back", async () => {
    const { plans, stored } = fakes();
    const response = await relabelPlan(
      plans,
      patch({ label: " Q3 " }),
      ID,
      OWNER,
    );
    expect(response.status).toBe(200);
    expect(
      (await response.json()) as { id: string; label: string | null },
    ).toEqual({ id: ID, label: "Q3" });
    expect(stored.label).toBe("Q3");
  });

  test("null clears the label", async () => {
    const { plans, stored } = fakes();
    stored.label = "old";
    const response = await relabelPlan(
      plans,
      patch({ label: null }),
      ID,
      OWNER,
    );
    expect(response.status).toBe(200);
    expect(stored.label).toBeNull();
  });

  test("404s for another account's plan without writing", async () => {
    const { plans, stored } = fakes();
    const response = await relabelPlan(
      plans,
      patch({ label: "mine" }),
      ID,
      OTHER,
    );
    expect(response.status).toBe(404);
    expect(stored.label).toBeNull();
  });

  test("rejects a body that is not JSON", async () => {
    const { plans } = fakes();
    const response = await relabelPlan(plans, patch("not json"), ID, OWNER);
    expect(response.status).toBe(400);
  });

  test("rejects a missing label field rather than clearing", async () => {
    const { plans, stored } = fakes();
    stored.label = "keep";
    const response = await relabelPlan(plans, patch({}), ID, OWNER);
    expect(response.status).toBe(400);
    expect(stored.label).toBe("keep");
  });

  test("rejects a non-string label", async () => {
    const { plans } = fakes();
    const response = await relabelPlan(plans, patch({ label: 7 }), ID, OWNER);
    expect(response.status).toBe(400);
  });

  test("rejects an over-long label", async () => {
    const { plans, stored } = fakes();
    const label = "x".repeat(MAX_PLAN_LABEL_LENGTH + 1);
    const response = await relabelPlan(plans, patch({ label }), ID, OWNER);
    expect(response.status).toBe(400);
    expect(stored.label).toBeNull();
  });
});
