import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newPlanId } from "../../../src/ids.ts";
import type { PlanRepo } from "../../../src/services/types.ts";
import { type DbFixture, FIXTURE_TIMEOUT_MS } from "../backends.ts";

/**
 * The `PlanRepo` contract, run against D1, bun:sqlite, and Postgres.
 *
 * The two implementations are not translations of one another. SQLite
 * serialises writers, so counting inside the claiming statement is atomic for
 * free; Postgres evaluates that count against a snapshot under READ
 * COMMITTED, and holds the ceiling with an advisory lock instead. Two ways of
 * being correct only stay two ways of being correct if both are measured
 * against the same behaviour, which is what this is.
 */

export function describePlanRepo(
  name: string,
  open: () => Promise<DbFixture>,
  options: { skip: boolean },
): void {
  describe.skipIf(options.skip)(`PlanRepo: ${name}`, () => {
    let fixture: DbFixture;
    let plans: PlanRepo;

    const row = (
      userId: string,
      over: { label?: string; size?: number } = {},
    ) => ({
      id: newPlanId(16),
      userId,
      label: over.label ?? null,
      size: over.size ?? 1,
    });

    beforeAll(async () => {
      fixture = await open();
      plans = fixture.plans;
    }, FIXTURE_TIMEOUT_MS);

    afterAll(async () => {
      await fixture.close();
    }, FIXTURE_TIMEOUT_MS);

    describe("claiming an id", () => {
      test("reports created, duplicate, and quota distinctly", async () => {
        const userId = await fixture.seedUser();
        const first = row(userId);

        expect(await plans.insert(first, 5)).toBe("created");
        // The same id again is a collision, which the caller retries with a
        // fresh one - the opposite handling from a full account.
        expect(await plans.insert(first, 5)).toBe("duplicate");
        expect(await plans.insert(row(userId), 1)).toBe("quota");
      });

      test("a duplicate id does not overwrite the plan already there", async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const mine = row(owner, { label: "mine", size: 111 });
        await plans.insert(mine, 5);

        // Another account guessing an existing id must not take it over.
        expect(
          await plans.insert(
            { ...mine, userId: stranger, label: "hijacked", size: 222 },
            5,
          ),
        ).toBe("duplicate");

        expect(await plans.findOwner(mine.id)).toBe(owner);
        const [stored] = await plans.listByUser(owner, 10);
        expect(stored?.label).toBe("mine");
        expect(stored?.size).toBe(111);
      });

      test("counts each account separately", async () => {
        const [a, b] = [await fixture.seedUser(), await fixture.seedUser()];
        expect(await plans.insert(row(a), 1)).toBe("created");
        // `b` is untouched by `a` filling its own allowance.
        expect(await plans.insert(row(b), 1)).toBe("created");
      });

      test("deleting a plan frees exactly one slot", async () => {
        const userId = await fixture.seedUser();
        const only = row(userId);

        expect(await plans.insert(only, 1)).toBe("created");
        expect(await plans.insert(row(userId), 1)).toBe("quota");
        expect(await plans.deleteOwned(only.id, userId)).toBe(true);
        expect(await plans.insert(row(userId), 1)).toBe("created");
        // The ceiling is a ceiling, not a lifetime total, and not two.
        expect(await plans.insert(row(userId), 1)).toBe("quota");
      });

      test("lowering the ceiling below what is stored refuses without deleting", async () => {
        const userId = await fixture.seedUser();
        for (let i = 0; i < 3; i += 1) await plans.insert(row(userId), 3);

        // An operator may lower MAX_PLANS_PER_USER; rows written under the old
        // value must survive it, they just stop being added to.
        expect(await plans.insert(row(userId), 1)).toBe("quota");
        expect(await fixture.countPlans(userId)).toBe(3);
      });

      /**
       * The regression the whole design of `insert` exists for. Every claim
       * that read the count first would see the same number and all pass.
       */
      test("admits exactly the ceiling when claims race", async () => {
        const userId = await fixture.seedUser();
        const limit = 5;
        const attempts = 40;

        const results = await Promise.all(
          Array.from({ length: attempts }, () =>
            plans.insert(row(userId), limit),
          ),
        );

        expect(results.filter((r) => r === "created")).toHaveLength(limit);
        expect(results.filter((r) => r === "quota")).toHaveLength(
          attempts - limit,
        );
        expect(await fixture.countPlans(userId)).toBe(limit);
      });

      test("racing accounts do not consume one another's allowance", async () => {
        const [a, b] = [await fixture.seedUser(), await fixture.seedUser()];

        await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            plans.insert(row(i % 2 === 0 ? a : b), 3),
          ),
        );

        expect(await fixture.countPlans(a)).toBe(3);
        expect(await fixture.countPlans(b)).toBe(3);
      });

      test("the same id claimed concurrently is created exactly once", async () => {
        const userId = await fixture.seedUser();
        const contested = row(userId);

        const results = await Promise.all(
          Array.from({ length: 8 }, () => plans.insert(contested, 50)),
        );

        expect(results.filter((r) => r === "created")).toHaveLength(1);
        expect(results.filter((r) => r === "duplicate")).toHaveLength(7);
        expect(await fixture.countPlans(userId)).toBe(1);
      });
    });

    describe("listing", () => {
      test("returns newest first, and only this account's plans", async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const ids: string[] = [];
        for (let i = 0; i < 4; i += 1) {
          const created = row(owner, { label: `plan ${i}` });
          await plans.insert(created, 10);
          // Backdated rather than slept for: two inserts can land in the same
          // millisecond, and a tie makes the order an implementation detail.
          await fixture.backdatePlan(created.id, 1_700_000_000_000 + i * 1_000);
          ids.push(created.id);
        }
        await plans.insert(row(stranger, { label: "not yours" }), 10);

        const listed = await plans.listByUser(owner, 10);
        expect(listed.map((plan) => plan.id)).toEqual([...ids].reverse());
        expect(listed.map((plan) => plan.label)).toEqual([
          "plan 3",
          "plan 2",
          "plan 1",
          "plan 0",
        ]);
      });

      test("caps at the limit, keeping the newest", async () => {
        const userId = await fixture.seedUser();
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          const created = row(userId);
          await plans.insert(created, 10);
          await fixture.backdatePlan(created.id, 1_700_000_000_000 + i * 1_000);
          ids.push(created.id);
        }

        const listed = await plans.listByUser(userId, 2);
        expect(listed.map((plan) => plan.id)).toEqual([
          ids[4] ?? "",
          ids[3] ?? "",
        ]);
      });

      test("a limit of zero returns nothing rather than everything", async () => {
        const userId = await fixture.seedUser();
        await plans.insert(row(userId), 10);
        expect(await plans.listByUser(userId, 0)).toEqual([]);
      });

      test("an account with no plans lists empty", async () => {
        expect(await plans.listByUser(await fixture.seedUser(), 10)).toEqual(
          [],
        );
      });

      test("an unknown account lists empty rather than throwing", async () => {
        expect(await plans.listByUser("no-such-user", 10)).toEqual([]);
      });

      test("carries the size and the created timestamp back", async () => {
        const userId = await fixture.seedUser();
        const created = row(userId, { label: "sized", size: 4096 });
        await plans.insert(created, 10);

        const [listed] = await plans.listByUser(userId, 10);
        expect(listed?.size).toBe(4096);
        expect(listed?.createdAt).toBeInstanceOf(Date);
        // A driver that returned epoch seconds where the other returns
        // milliseconds would put this in 1970.
        expect(listed?.createdAt.getUTCFullYear()).toBeGreaterThan(2020);
      });
    });

    describe("ownership", () => {
      test("findOwner answers for a stored plan and misses otherwise", async () => {
        const userId = await fixture.seedUser();
        const created = row(userId);
        await plans.insert(created, 10);

        expect(await plans.findOwner(created.id)).toBe(userId);
        expect(await plans.findOwner(newPlanId(16))).toBeNull();
      });

      test("relabel stores, trims to null, and refuses a stranger", async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const created = row(owner, { label: "before" });
        await plans.insert(created, 10);

        expect(await plans.relabel(created.id, owner, "after")).toBe(true);
        expect((await plans.listByUser(owner, 1))[0]?.label).toBe("after");

        expect(await plans.relabel(created.id, owner, null)).toBe(true);
        expect((await plans.listByUser(owner, 1))[0]?.label).toBeNull();

        expect(await plans.relabel(created.id, stranger, "hijacked")).toBe(
          false,
        );
        expect(await plans.relabel(newPlanId(16), owner, "ghost")).toBe(false);
        expect((await plans.listByUser(owner, 1))[0]?.label).toBeNull();
      });

      test("resize records the new size and refuses a stranger", async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const created = row(owner, { size: 10 });
        await plans.insert(created, 10);

        expect(await plans.resize(created.id, owner, 999)).toBe(true);
        expect((await plans.listByUser(owner, 1))[0]?.size).toBe(999);

        // This boolean is what authorises the object write that follows it, so
        // a false positive here overwrites somebody else's document.
        expect(await plans.resize(created.id, stranger, 1)).toBe(false);
        expect(await plans.resize(newPlanId(16), owner, 1)).toBe(false);
        expect((await plans.listByUser(owner, 1))[0]?.size).toBe(999);
      });

      test("resize keeps the label, and relabel keeps the size", async () => {
        const owner = await fixture.seedUser();
        const created = row(owner, { label: "keep me", size: 10 });
        await plans.insert(created, 10);

        await plans.resize(created.id, owner, 500);
        expect((await plans.listByUser(owner, 1))[0]?.label).toBe("keep me");

        await plans.relabel(created.id, owner, "renamed");
        expect((await plans.listByUser(owner, 1))[0]?.size).toBe(500);
      });

      test("deleteOwned removes once, then reports nothing to remove", async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const created = row(owner);
        await plans.insert(created, 10);

        expect(await plans.deleteOwned(created.id, stranger)).toBe(false);
        expect(await fixture.countPlans(owner)).toBe(1);

        expect(await plans.deleteOwned(created.id, owner)).toBe(true);
        expect(await plans.deleteOwned(created.id, owner)).toBe(false);
        expect(await fixture.countPlans(owner)).toBe(0);
      });

      test("a concurrent delete reports success exactly once", async () => {
        const owner = await fixture.seedUser();
        const created = row(owner);
        await plans.insert(created, 10);

        // The caller deletes the object only when this is true. Two trues
        // would mean two callers each believing they own the cleanup.
        const results = await Promise.all(
          Array.from({ length: 8 }, () => plans.deleteOwned(created.id, owner)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });

    describe("hostile field values", () => {
      /**
       * No NUL byte here, deliberately. Postgres refuses `\u0000` in a `text`
       * value at the wire level while SQLite stores it, so the two genuinely
       * cannot agree - and they do not have to: `parsePlanLabel` rejects every
       * control character before a label reaches a repository (see
       * tests/plan-label.test.ts), so no label carrying one exists to store.
       */
      test.each([
        ["sql fragment", "'; drop table plan; --"],
        ["quote storm", `"'"''""--/*`],
        ["like metacharacters", "100% off_er"],
        ["unicode and emoji", "Café plan 🚀 日本語"],
        ["newlines", "line one\nline two"],
      ])("a %s label is stored as data, verbatim", async (_, label) => {
        const userId = await fixture.seedUser();
        const created = row(userId, { label });
        await plans.insert(created, 10);

        expect((await plans.listByUser(userId, 1))[0]?.label).toBe(label);
        // The table is still there, and nothing else was touched.
        expect(await fixture.countPlans(userId)).toBe(1);

        await plans.relabel(created.id, userId, `${label} edited`);
        expect((await plans.listByUser(userId, 1))[0]?.label).toBe(
          `${label} edited`,
        );
      });

      test("a label at four kilobytes round-trips", async () => {
        const userId = await fixture.seedUser();
        // `parsePlanLabel` caps this far lower, so the column is proved to be
        // the looser of the two bounds rather than a second, hidden one.
        const label = "x".repeat(4096);
        const created = row(userId, { label });
        await plans.insert(created, 10);
        expect((await plans.listByUser(userId, 1))[0]?.label).toBe(label);
      });

      test("lookups match the whole id, never a pattern", async () => {
        const userId = await fixture.seedUser();
        const created = row(userId);
        await plans.insert(created, 10);

        // `%` and `_` are LIKE metacharacters. An equality comparison ignores
        // them; a query that had drifted to LIKE would resolve these onto the
        // real plan and hand a stranger somebody else's document.
        for (const probe of ["%", "_", `${created.id}%`, `%${created.id}`]) {
          expect(await plans.findOwner(probe)).toBeNull();
          expect(await plans.relabel(probe, userId, "x")).toBe(false);
          expect(await plans.deleteOwned(probe, userId)).toBe(false);
        }
        expect(await fixture.countPlans(userId)).toBe(1);
      });

      test("a size of zero is stored, not treated as absent", async () => {
        const userId = await fixture.seedUser();
        const created = row(userId, { size: 0 });
        await plans.insert(created, 10);
        expect((await plans.listByUser(userId, 1))[0]?.size).toBe(0);
      });
    });

    describe("account deletion", () => {
      test("removing the user removes the plans", async () => {
        const userId = await fixture.seedUser();
        for (let i = 0; i < 3; i += 1) await plans.insert(row(userId), 10);
        expect(await fixture.countPlans(userId)).toBe(3);

        // Without the cascade the rows survive their owner, and the objects
        // they name are unreachable forever.
        await fixture.deleteUser(userId);
        expect(await fixture.countPlans(userId)).toBe(0);
      });

      test("removing one account leaves another's plans alone", async () => {
        const [doomed, kept] = [
          await fixture.seedUser(),
          await fixture.seedUser(),
        ];
        await plans.insert(row(doomed), 10);
        await plans.insert(row(kept), 10);

        await fixture.deleteUser(doomed);
        expect(await fixture.countPlans(kept)).toBe(1);
      });
    });
  });
}
