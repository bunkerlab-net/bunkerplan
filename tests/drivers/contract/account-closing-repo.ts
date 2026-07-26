import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccountClosingRepo } from "../../../src/services/types.ts";
import { type DbFixture, FIXTURE_TIMEOUT_MS } from "../backends.ts";

/**
 * The `AccountClosingRepo` contract, run against D1, bun:sqlite, and Postgres.
 *
 * The marker is what stops an upload slipping between the object sweep and
 * the row cascade and leaving an object nothing owns. Two properties carry
 * that: `open` is idempotent, so a deletion retried after a failure does not
 * trip over its own previous attempt, and `isOpen` is per account, so one
 * closing account cannot lock everybody else out of uploading.
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

    test("marking twice is not an error", async () => {
      const userId = await fixture.seedUser();
      await closing.open(userId);
      // A deletion that failed partway is retried, and the marker its own
      // previous attempt left must not be what stops the retry.
      await closing.open(userId);
      await closing.open(userId);
      expect(await closing.isOpen(userId)).toBe(true);
      expect(await fixture.countAccountClosings(userId)).toBe(1);
    });

    test("concurrent marks settle on one row without throwing", async () => {
      const userId = await fixture.seedUser();
      await Promise.all(Array.from({ length: 8 }, () => closing.open(userId)));
      expect(await closing.isOpen(userId)).toBe(true);
      expect(await fixture.countAccountClosings(userId)).toBe(1);
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
     * The safe direction, and deliberate: a completed deletion cleans the
     * marker up, a failed one leaves it, and the account stays unusable until
     * an operator looks.
     */
    test("completing the deletion takes the marker with the account", async () => {
      const userId = await fixture.seedUser();
      await closing.open(userId);
      expect(await fixture.countAccountClosings(userId)).toBe(1);

      await fixture.deleteUser(userId);
      expect(await fixture.countAccountClosings(userId)).toBe(0);
    });
  });
}
