import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RateLimitRepo } from "../../../src/services/types.ts";
import { type DbFixture, FIXTURE_TIMEOUT_MS } from "../backends.ts";

/**
 * The unlock bucket's contract, run against D1, bun:sqlite, and Postgres.
 *
 * Shares its `consume` with the upload limiter, so the window and concurrency
 * assertions live in rate-limit-repo.ts and are not repeated here. What is only
 * true of this table is asserted here: its key is not a user id, and because
 * there is no owner to cascade from, it prunes its own closed windows.
 */

const WINDOW = 60;
const MAX = 3;

export function describeUnlockRateLimitRepo(
  name: string,
  open: () => Promise<DbFixture>,
  options: { skip: boolean },
): void {
  describe.skipIf(options.skip)(`unlock RateLimitRepo: ${name}`, () => {
    let fixture: DbFixture;
    let limits: RateLimitRepo;

    const consume = (address: string, max = MAX) =>
      limits.consume(address, max, WINDOW);

    beforeAll(async () => {
      fixture = await open();
      limits = fixture.unlockRateLimits;
    }, FIXTURE_TIMEOUT_MS);

    afterAll(async () => {
      await fixture.close();
    }, FIXTURE_TIMEOUT_MS);

    test("counts an address that is not a user id", async () => {
      // The whole reason this is a second table. `upload_rate_limit.key` is a
      // foreign key onto `user.id`, so this insert would be refused there.
      const result = await consume("203.0.113.7");
      expect(result.allowed).toBe(true);
    });

    test("refuses past the ceiling, then allows a rolled window", async () => {
      const address = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
      for (let i = 0; i < MAX; i += 1) {
        expect((await consume(address)).allowed).toBe(true);
      }

      const refused = await consume(address);
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfter).toBeGreaterThan(0);

      // Ages this address's window rather than waiting a minute for it.
      await fixture.backdateUnlockWindow(
        address,
        Date.now() - (WINDOW + 1) * 1_000,
      );
      expect((await consume(address)).allowed).toBe(true);
    });

    test("one address cannot spend another's allowance", async () => {
      // The property that makes an anonymous limiter safe here: were the bucket
      // the plan, anyone holding the share link could exhaust it and lock the
      // rest of its readers out.
      const noisy = "192.0.2.10";
      const quiet = "192.0.2.11";
      for (let i = 0; i < MAX; i += 1) await consume(noisy);
      expect((await consume(noisy)).allowed).toBe(false);
      expect((await consume(quiet)).allowed).toBe(true);
    });

    test("sweeps a closed window left by an address that never returned", async () => {
      const stale = "192.0.2.99";
      await consume(stale);
      await fixture.backdateUnlockWindow(
        stale,
        Date.now() - (WINDOW + 1) * 1_000,
      );

      const before = await fixture.countUnlockRows();
      // Any other address redeeming is what collects it. Nothing else prunes
      // this table, so without the sweep the row would outlive the deployment.
      await consume("192.0.2.100");
      const after = await fixture.countUnlockRows();

      // The stale row went and the fresh one arrived, so the count holds.
      expect(after).toBe(before);
      expect(await fixture.countUnlockRows()).toBeGreaterThan(0);
    });

    /**
     * The sweep is bounded, and this is the table that makes that matter: its
     * key is a digest of a client address and nothing owns it, so a flood from
     * many addresses leaves a row each. An unbounded prune would hand the one
     * redemption that drew the sweep a delete over every row that ever
     * accumulated - long enough to trip a statement timeout or a D1 query
     * limit, and a sweep that throws is one that never gets further, so the
     * backlog it choked on would only grow.
     *
     * Run at a batch of one, because the real ceiling is 500 and seeding that
     * against three servers would prove the same thing slowly.
     */
    test("removes at most one batch per redemption, and drains", async () => {
      const bounded = fixture.unlockRateLimitsOneAtATime;
      const closed = ["198.51.100.201", "198.51.100.202", "198.51.100.203"];
      const stale = Date.now() - (WINDOW + 1) * 1_000;
      // Every row first, then aged. Interleaved, each `consume` would sweep
      // the one aged just before it and the backlog would never reach three.
      for (const address of closed) {
        await bounded.consume(address, MAX, WINDOW);
      }
      for (const address of closed) {
        await fixture.backdateUnlockWindow(address, stale);
      }

      const before = await fixture.countUnlockRows();

      // Each redemption adds its own fresh row and takes exactly one closed
      // one, so the total holds. A sweep that took the lot would drop it to
      // `before - closed.length + 1` on the first call and leave it there.
      await bounded.consume("198.51.100.210", MAX, WINDOW);
      expect(await fixture.countUnlockRows()).toBe(before);

      await bounded.consume("198.51.100.211", MAX, WINDOW);
      expect(await fixture.countUnlockRows()).toBe(before);

      // And the backlog is gone rather than circled: three closed rows, three
      // sweeps that each took the oldest.
      await bounded.consume("198.51.100.212", MAX, WINDOW);
      for (const address of closed) {
        expect(await fixture.countUnlockRows(address)).toBe(0);
      }
    });
  });
}
