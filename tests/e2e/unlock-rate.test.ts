import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Harness,
  html,
  startWorker,
  UNLOCK_RATE_MAX,
  upload,
} from "./harness.ts";

/**
 * Redeeming a share code is the only route that takes no credential, so it is
 * the only one whose allowance cannot be charged to an account. It is charged to
 * the client address instead - never to the plan, whose id is printed in the
 * share link and would let anyone holding that link lock the real readers out.
 */

const BOOT_TIMEOUT_MS = 120_000;
const WRONG = "wrongcodewrongcode";

let app: Harness;

beforeAll(async () => {
  app = await startWorker();
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
}, BOOT_TIMEOUT_MS);

/**
 * Each test names its own address, so no test can spend another's allowance.
 * The suite shares one worker, and the window outlives the whole run.
 */
function attempt(planId: string, address: string, code: string) {
  return app.fetch(`/api/plans/${planId}/unlock`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": address,
    },
    body: JSON.stringify({ code }),
  });
}

async function codedPlan(): Promise<{ id: string; code: string }> {
  const { key, cookie } = await app.accountWithSession();
  const created = await app.fetch("/api/plans?visibility=private", {
    ...upload(key, html("gated")),
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const minted = await app.fetch(`/api/plans/${id}/share-code`, {
    method: "POST",
    headers: { cookie },
  });
  expect(minted.status).toBe(201);
  return { id, code: ((await minted.json()) as { code: string }).code };
}

describe("the unlock rate limit", () => {
  test("spends the address's allowance, then refuses even a correct code", async () => {
    const plan = await codedPlan();
    const address = "203.0.113.20";

    // Wrong codes count. What the ceiling bounds is attempts that spend the
    // deployment's work, and a limiter counting only successes would bound
    // nothing at all.
    for (let i = 0; i < UNLOCK_RATE_MAX; i += 1) {
      expect((await attempt(plan.id, address, WRONG)).status).toBe(401);
    }

    const limited = await attempt(plan.id, address, WRONG);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    // Holding the real code does not buy a way past it.
    expect((await attempt(plan.id, address, plan.code)).status).toBe(429);
  });

  test("one address spending its allowance leaves another's intact", async () => {
    const plan = await codedPlan();
    const noisy = "203.0.113.21";
    const quiet = "203.0.113.22";

    for (let i = 0; i < UNLOCK_RATE_MAX; i += 1) {
      await attempt(plan.id, noisy, WRONG);
    }
    expect((await attempt(plan.id, noisy, plan.code)).status).toBe(429);

    // The property that makes an anonymous limiter safe here: a stranger
    // hammering a share link cannot keep the plan's real readers out.
    const other = await attempt(plan.id, quiet, plan.code);
    expect(other.status).toBe(204);
    expect(other.headers.get("set-cookie")).toContain(plan.id);
  });
});
