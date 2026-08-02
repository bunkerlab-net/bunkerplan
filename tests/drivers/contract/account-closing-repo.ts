import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccountClosingRepo } from "../../../src/services/types.ts";
import { type DbFixture, FIXTURE_TIMEOUT_MS } from "../backends.ts";

/**
 * The `AccountClosingRepo` contract, run against D1, bun:sqlite, and Postgres.
 *
 * The marker is what stops an upload slipping between the object sweep and
 * the row cascade and leaving an object nothing owns. Three properties carry
 * that: `isOpen` is per account, so one closing account cannot lock everybody
 * else out of uploading; a mark belongs to the attempt that placed it, so a
 * failed deletion lifting its own cannot end a concurrent one's protection;
 * and the cascade collects every mark an account has, however many attempts
 * left one.
 */

export function describeAccountClosingRepo(
  name: string,
  open: () => Promise<DbFixture>,
  options: { skip: boolean },
): void {
  describe.skipIf(options.skip)(`AccountClosingRepo: ${name}`, () => {
    let fixture: DbFixture;
    let closing: AccountClosingRepo;

    beforeAll(async () => {
      fixture = await open();
      closing = fixture.accountClosing;
    }, FIXTURE_TIMEOUT_MS);

    afterAll(async () => {
      await fixture.close();
    }, FIXTURE_TIMEOUT_MS);

    test("an account is not closing until it is marked", async () => {
      expect(await closing.isOpen(await fixture.seedUser())).toBe(false);
    });

    test("marking makes it closing", async () => {
      const userId = await fixture.seedUser();
      await closing.open(userId);
      expect(await closing.isOpen(userId)).toBe(true);
    });

    test("each attempt gets its own mark", async () => {
      const userId = await fixture.seedUser();
      // A deletion that failed partway is retried, and the marker its own
      // previous attempt left must not be what stops the retry.
      const first = await closing.open(userId);
      const second = await closing.open(userId);

      expect(second).not.toBe(first);
      expect(await closing.isOpen(userId)).toBe(true);
      expect(await fixture.countAccountClosings(userId)).toBe(2);
    });

    test("concurrent marks all land, and none collides", async () => {
      const userId = await fixture.seedUser();
      const ids = await Promise.all(
        Array.from({ length: 8 }, () => closing.open(userId)),
      );
      expect(new Set(ids).size).toBe(8);
      expect(await closing.isOpen(userId)).toBe(true);
      expect(await fixture.countAccountClosings(userId)).toBe(8);
    });

    /**
     * The property the per-attempt key exists for. Two deletions of one
     * account overlap; the first to fail lifts its own mark and the account
     * must still read as closing, because the other is still sweeping and the
     * upload it is racing has to keep being refused.
     */
    test("lifting one attempt's mark leaves another's standing", async () => {
      const userId = await fixture.seedUser();
      const failing = await closing.open(userId);
      await closing.open(userId);

      await closing.close(failing);

      expect(await closing.isOpen(userId)).toBe(true);
      expect(await fixture.countAccountClosings(userId)).toBe(1);
    });

    test("lifting the last mark reopens the account", async () => {
      const userId = await fixture.seedUser();
      const only = await closing.open(userId);

      await closing.close(only);

      expect(await closing.isOpen(userId)).toBe(false);
      expect(await fixture.countAccountClosings(userId)).toBe(0);
    });

    test("lifting a mark twice is not an error", async () => {
      // The sweep's cleanup runs on an already-failing path and must not add a
      // second failure of its own.
      const userId = await fixture.seedUser();
      const attemptId = await closing.open(userId);

      await closing.close(attemptId);
      await expect(closing.close(attemptId)).resolves.toBeUndefined();
      await expect(
        closing.close(`ghost-${crypto.randomUUID()}`),
      ).resolves.toBeUndefined();
    });

    test("one closing account does not close another", async () => {
      const [doomed, other] = [
        await fixture.seedUser(),
        await fixture.seedUser(),
      ];
      await closing.open(doomed);

      // Uploads refuse while this is true, so a marker that read as set for
      // everybody would take the whole deployment down.
      expect(await closing.isOpen(doomed)).toBe(true);
      expect(await closing.isOpen(other)).toBe(false);
    });

    test("an unknown account reads as not closing rather than throwing", async () => {
      expect(await closing.isOpen(`ghost-${crypto.randomUUID()}`)).toBe(false);
    });

    test("marking an account that does not exist is refused", async () => {
      // The marker cascades from `user`, so a row for a missing account would
      // be permanent and unreachable. The foreign key is what prevents it.
      await expect(
        closing.open(`ghost-${crypto.randomUUID()}`),
      ).rejects.toThrow();
    });

    /**
     * Every mark, not just one. An attempt that failed after its sweep leaves
     * a row nothing will lift; the account is still deletable, and completing
     * that deletion has to collect the stale row along with the live one.
     */
    test("completing the deletion takes every mark with the account", async () => {
      const userId = await fixture.seedUser();
      await closing.open(userId);
      await closing.open(userId);
      expect(await fixture.countAccountClosings(userId)).toBe(2);

      await fixture.deleteUser(userId);
      expect(await fixture.countAccountClosings(userId)).toBe(0);
    });
  });
}
