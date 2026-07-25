import { describe, expect, test } from "bun:test";
import { planUrl } from "../src/http/plan-url.ts";

describe("planUrl", () => {
  // The public URL shape is the product: it is pasted into chat, mail and
  // documents, and every one of those copies breaks if the prefix moves. This
  // asserts the contract so a change to it has to be deliberate.
  test("puts plans under /p", () => {
    expect(planUrl("https://plans.example.com", "aB3xQ7")).toBe(
      "https://plans.example.com/p/aB3xQ7",
    );
  });

  test("does not double the separator for a base URL with no path", () => {
    expect(planUrl("http://localhost:3000", "id")).toBe(
      "http://localhost:3000/p/id",
    );
  });
});
