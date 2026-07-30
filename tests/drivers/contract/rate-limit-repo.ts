import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RateLimitRepo } from "../../../src/services/types.ts";
import { type DbFixture, FIXTURE_TIMEOUT_MS } from "../backends.ts";

/**
 * The `RateLimitRepo` contract, run against D1, bun:sqlite, and Postgres.
 *
 * This is the only thing bounding how fast an account can write, so the two
 * dialects disagreeing means one deployment enforces a policy the operator
 * did not configure. The decision is one conditional upsert in both, and the
 * assertions below are mostly about what that statement must not do: let a
 * concurrent burst through, extend a window on a refusal, or resurrect a
 * counter for an account that no longer exists.
 */

const WINDOW = 60;
const MAX = 3;

export function describeRateLimitRepo(
  name: string,
  open: () => Promise<DbFixture>,
  options: { skip: boolean },
): void {
  describe.skipIf(options.skip)(`RateLimitRepo: ${name}`, () => {
    let fixture: DbFixture;
    let limits: RateLimitRepo;

    /** The key is a user id, so the row has an owner to cascade from. */
    const account = () => fixture.seedUser();
    const consume = (key: string, max = MAX) =>
      limits.consume(key, max, WINDOW);
    const peek = (key: string, max = MAX) => limits.peek(key, max, WINDOW);

    /** Puts the stored window far enough back that the next call rolls it. */
    const ageOut = (key: string) =>
      fixture.backdateRateWindow(key, Date.now() - (WINDOW + 1) * 1_000);

    beforeAll(async () => {
      fixture = await open();
      limits = fixture.rateLimits;
    }, FIXTURE_TIMEOUT_MS);

    afterAll(async () => {
      await fixture.close();
    }, FIXTURE_TIMEOUT_MS);

    describe("the window", () => {
      test("allows up to max, then refuses", async () => {
        const key = await account();
        const verdicts: boolean[] = [];
        for (let i = 0; i < MAX + 2; i += 1) {
          verdicts.push((await consume(key)).allowed);
        }
        expect(verdicts).toEqual([true, true, true, false, false]);
      });

      test("a refusal carries a retryAfter inside the window", async () => {
        const key = await account();
        for (let i = 0; i < MAX; i += 1) await consume(key);

        const refused = await consume(key);
        expect(refused.allowed).toBe(false);
        // Zero would tell a client to retry immediately, forever.
        expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
        expect(refused.retryAfter).toBeLessThanOrEqual(WINDOW);
      });

      test("an allowed call also reports the time left", async () => {
        const first = await consume(await account());
        expect(first.allowed).toBe(true);
        expect(first.retryAfter).toBeGreaterThanOrEqual(1);
        expect(first.retryAfter).toBeLessThanOrEqual(WINDOW);
      });

      test("the count resets once the window has rolled over", async () => {
        const key = await account();
        for (let i = 0; i < MAX; i += 1) await consume(key);
        expect((await consume(key)).allowed).toBe(false);

        await ageOut(key);
        expect((await consume(key)).allowed).toBe(true);
        // A rollover that reset the window but not the count, or the other
        // way round, would show up as the wrong number of further calls.
        expect((await consume(key)).allowed).toBe(true);
        expect((await consume(key)).allowed).toBe(true);
        expect((await consume(key)).allowed).toBe(false);
      });

      /**
       * A refusal must not restart the clock. If it did, a caller hammering a
       * limit it has already hit would push its own recovery indefinitely
       * further away - the limit would become permanent under load.
       */
      test("a refusal does not extend the window", async () => {
        const key = await account();
        for (let i = 0; i < MAX; i += 1) await consume(key);
        const started = await fixture.rateWindowStart(key);

        const first = await consume(key);
        for (let i = 0; i < 5; i += 1) await consume(key);
        const last = await consume(key);

        expect(last.allowed).toBe(false);
        expect(last.retryAfter).toBeLessThanOrEqual(first.retryAfter);
        // The stored value, not just the derived countdown: a `setWhere` that
        // matched on a refusal would move this and reset the count with it.
        expect(await fixture.rateWindowStart(key)).toBe(started);
      });

      test("a window that has only just started is not treated as elapsed", async () => {
        const key = await account();
        await consume(key);
        // Exactly at the boundary rather than past it: the comparison is
        // `<=`, so a window starting now must still be the current one.
        await fixture.backdateRateWindow(key, Date.now());
        expect((await consume(key)).allowed).toBe(true);
        expect((await consume(key)).allowed).toBe(true);
        expect((await consume(key)).allowed).toBe(false);
      });
    });

    /**
     * `peek` is the same decision without the spend, and the unlock route leans
     * on both halves being the same decision: it gates on this and charges only
     * a refused attempt, so a `peek` that disagreed with `consume` about where
     * the window ended would either ration nothing or refuse a reader whose
     * budget was intact.
     */
    describe("reading the budget without spending it", () => {
      test("an untouched key has its whole budget", async () => {
        const key = await account();

        expect((await peek(key)).allowed).toBe(true);
        // And still does: asking is not spending, which is the entire point.
        for (let i = 0; i < MAX + 2; i += 1) {
          expect((await peek(key)).allowed).toBe(true);
        }
        expect((await consume(key)).allowed).toBe(true);
      });

      test("it refuses exactly when the next spend would", async () => {
        const key = await account();
        for (let i = 0; i < MAX - 1; i += 1) {
          expect((await peek(key)).allowed).toBe(true);
          await consume(key);
        }

        // One left: still allowed, and spending it is what closes the bucket.
        expect((await peek(key)).allowed).toBe(true);
        expect((await consume(key)).allowed).toBe(true);
        expect((await peek(key)).allowed).toBe(false);
        expect((await consume(key)).allowed).toBe(false);
      });

      test("a refusal carries the wait, and a rollover clears it", async () => {
        const key = await account();
        for (let i = 0; i < MAX; i += 1) await consume(key);

        const refused = await peek(key);
        expect(refused.allowed).toBe(false);
        // Zero would tell a client to retry immediately, forever.
        expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
        expect(refused.retryAfter).toBeLessThanOrEqual(WINDOW);

        await ageOut(key);
        // Read from the stored window rather than a stored verdict, so this
        // rolls over without anything having to spend first.
        expect((await peek(key)).allowed).toBe(true);
      });
    });

    describe("isolation", () => {
      test("each key gets its own allowance", async () => {
        const [a, b] = [await account(), await account()];
        for (let i = 0; i < MAX; i += 1) await consume(a);

        expect((await consume(a)).allowed).toBe(false);
        expect((await consume(b)).allowed).toBe(true);
      });

      test("a lower max for one call does not shrink the stored window", async () => {
        const key = await account();
        expect((await consume(key, 1)).allowed).toBe(true);
        expect((await consume(key, 1)).allowed).toBe(false);
        // The ceiling is an argument, not state: raising it lets the same
        // counter through again inside the same window.
        expect((await consume(key, 5)).allowed).toBe(true);
      });
    });

    describe("concurrency", () => {
      /**
       * The upsert has to be the whole decision. Two first calls for a key
       * that has no row yet both insert, and only one can win the primary
       * key - so the loser must fall into the update branch and be counted,
       * not dropped.
       */
      test("two concurrent first calls both count", async () => {
        const key = await account();
        const first = await Promise.all([consume(key), consume(key)]);
        expect(first.map((r) => r.allowed)).toEqual([true, true]);

        // Two spent, so exactly one is left.
        expect((await consume(key)).allowed).toBe(true);
        expect((await consume(key)).allowed).toBe(false);
      });

      test("a burst never admits more than max", async () => {
        const key = await account();
        const results = await Promise.all(
          Array.from({ length: 30 }, () => consume(key, 5)),
        );
        expect(results.filter((r) => r.allowed)).toHaveLength(5);
      });

      test("bursts on different keys do not interfere", async () => {
        const [a, b] = [await account(), await account()];
        const results = await Promise.all(
          Array.from({ length: 30 }, (_, i) => consume(i % 2 === 0 ? a : b, 5)),
        );
        expect(results.filter((r) => r.allowed)).toHaveLength(10);
      });
    });

    describe("hostile keys", () => {
      test("an unknown key is counted without a user row behind it", async () => {
        // Nothing prunes this table and the key is a foreign key on SQLite as
        // well as Postgres, so an id that never existed must be refused by the
        // constraint rather than silently creating a counter.
        await expect(consume(`ghost-${crypto.randomUUID()}`)).rejects.toThrow();
      });

      test("a key carrying SQL is data, and the table survives", async () => {
        const key = await account();
        await consume(key);
        // The key is bound, never interpolated; if it were not, this would
        // take the table with it and the assertion below would throw.
        await expect(
          limits.consume("'; drop table upload_rate_limit; --", MAX, WINDOW),
        ).rejects.toThrow();
        expect((await consume(key)).allowed).toBe(true);
      });
    });

    describe("account deletion", () => {
      /**
       * Nothing prunes this table, so without the cascade a deleted account
       * leaves its counter behind for good - and a new account can never be
       * issued that id, so the row is unreachable as well as permanent.
       */
      test("removing the user removes the counter", async () => {
        const key = await account();
        await consume(key);
        expect(await fixture.countRateLimits(key)).toBe(1);

        await fixture.deleteUser(key);
        expect(await fixture.countRateLimits(key)).toBe(0);
      });
    });
  });
}
