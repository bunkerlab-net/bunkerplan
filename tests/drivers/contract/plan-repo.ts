import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newPlanId } from "../../../src/ids.ts";
import type { PlanRepo, PlanVisibility } from "../../../src/services/types.ts";
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
      over: {
        label?: string;
        size?: number;
        visibility?: PlanVisibility;
        shareCodeHash?: string;
      } = {},
    ) => ({
      id: newPlanId(16),
      userId,
      label: over.label ?? null,
      size: over.size ?? 1,
      visibility: over.visibility ?? ("private" as const),
      shareCodeHash: over.shareCodeHash ?? null,
    });

    /**
     * A grant is addressed by handle, and `user.email` is unique, so every
     * seeded handle in this suite has to be distinct from every other.
     */
    const uniqueHandle = () => `h${crypto.randomUUID().replaceAll("-", "")}`;

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

      test("removing a grantee removes the grant, not the plan", async () => {
        const owner = await fixture.seedUser();
        const handle = uniqueHandle();
        const grantee = await fixture.seedUser(handle);
        const created = row(owner);
        await plans.insert(created, 10);
        expect(await plans.grantByHandle(created.id, owner, handle)).toBe(
          "granted",
        );

        // Without the cascade this delete either fails on the foreign key or
        // leaves a row naming an account that no longer exists.
        await fixture.deleteUser(grantee);
        expect(await plans.hasGrant(created.id, grantee)).toBe(false);
        expect(await fixture.countPlans(owner)).toBe(1);
      });
    });

    describe("visibility and the share code", () => {
      test("insert persists both in the claiming statement", async () => {
        const userId = await fixture.seedUser();
        const created = row(userId, {
          visibility: "public",
          shareCodeHash: "a".repeat(64),
        });
        expect(await plans.insert(created, 10)).toBe("created");

        expect(await plans.findAccess(created.id)).toEqual({
          ownerId: userId,
          visibility: "public",
          shareCodeHash: "a".repeat(64),
        });
      });

      test("findAccess reports null for an id nobody claimed", async () => {
        expect(await plans.findAccess(newPlanId(16))).toBeNull();
      });

      test("listByUser reports the code as a flag, never the hash", async () => {
        const userId = await fixture.seedUser();
        const created = row(userId, { shareCodeHash: "b".repeat(64) });
        await plans.insert(created, 10);

        const [listed] = await plans.listByUser(userId, 1);
        expect(listed?.visibility).toBe("private");
        expect(listed?.hasShareCode).toBe(true);
        // The digest is a preimage target; nothing outside the repo needs it.
        expect(JSON.stringify(listed)).not.toContain("b".repeat(64));
      });

      test("listByUser reports whether anyone is named on the plan", async () => {
        const owner = await fixture.seedUser();
        const handle = uniqueHandle();
        await fixture.seedUser(handle);
        const created = row(owner);
        await plans.insert(created, 10);

        expect((await plans.listByUser(owner, 1))[0]?.hasGrants).toBe(false);

        expect(await plans.grantByHandle(created.id, owner, handle)).toBe(
          "granted",
        );
        expect((await plans.listByUser(owner, 1))[0]?.hasGrants).toBe(true);

        expect(await plans.revokeByHandle(created.id, owner, handle)).toBe(
          true,
        );
        expect((await plans.listByUser(owner, 1))[0]?.hasGrants).toBe(false);
      });

      test("a plan shared with several accounts is still one row", async () => {
        /*
         * `exists`, not a join: a join against `plan_grant` multiplies the
         * plan row once per grantee, which reads as three plans in the
         * dashboard and pushes real ones off the end of the page.
         */
        const owner = await fixture.seedUser();
        const created = row(owner);
        await plans.insert(created, 10);
        for (let index = 0; index < 3; index += 1) {
          const handle = uniqueHandle();
          await fixture.seedUser(handle);
          expect(await plans.grantByHandle(created.id, owner, handle)).toBe(
            "granted",
          );
        }

        const listed = await plans.listByUser(owner, 10);
        expect(listed.length).toBe(1);
        expect(listed[0]?.hasGrants).toBe(true);
      });

      test("one plan's grants do not mark another's", async () => {
        // The subquery is correlated; a stray one would answer "anyone at all
        // has a grant" and light up every row in the account.
        const owner = await fixture.seedUser();
        const handle = uniqueHandle();
        await fixture.seedUser(handle);
        const shared = row(owner, { label: "shared" });
        const alone = row(owner, { label: "alone" });
        await plans.insert(shared, 10);
        await plans.insert(alone, 10);
        expect(await plans.grantByHandle(shared.id, owner, handle)).toBe(
          "granted",
        );

        const listed = await plans.listByUser(owner, 10);
        const granted = (label: string) =>
          listed.find((plan) => plan.label === label)?.hasGrants;
        expect(granted("shared")).toBe(true);
        expect(granted("alone")).toBe(false);
      });

      test("setVisibility and setShareCodeHash refuse a stranger", async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const created = row(owner);
        await plans.insert(created, 10);

        expect(await plans.setVisibility(created.id, stranger, "public")).toBe(
          false,
        );
        expect(await plans.setShareCodeHash(created.id, stranger, "c")).toBe(
          false,
        );
        expect((await plans.findAccess(created.id))?.visibility).toBe(
          "private",
        );
        expect((await plans.findAccess(created.id))?.shareCodeHash).toBeNull();
      });

      test("a public plan cannot be given a code, a private one can", async () => {
        const owner = await fixture.seedUser();
        const created = row(owner);
        await plans.insert(created, 10);
        expect(await plans.setVisibility(created.id, owner, "public")).toBe(
          true,
        );

        // A public plan is readable by anyone holding the URL, so a *new* code
        // would gate nothing. Pinned in both dialects because the guard lives
        // in the update statement, where a concurrent flip cannot get round it.
        expect(
          await plans.setShareCodeHash(created.id, owner, "d".repeat(64)),
        ).toBe(false);
        expect((await plans.findAccess(created.id))?.shareCodeHash).toBeNull();

        // Private again, and now a code is allowed.
        expect(await plans.setVisibility(created.id, owner, "private")).toBe(
          true,
        );
        expect(
          await plans.setShareCodeHash(created.id, owner, "d".repeat(64)),
        ).toBe(true);
        expect(await plans.findAccess(created.id)).toEqual({
          ownerId: owner,
          visibility: "private",
          shareCodeHash: "d".repeat(64),
        });
      });

      test("going public keeps the code", async () => {
        const owner = await fixture.seedUser();
        const coded = row(owner, {
          visibility: "private",
          shareCodeHash: "d".repeat(64),
        });
        await plans.insert(coded, 10);

        // The flip says who may read the plan; it says nothing about the
        // credential. Clearing here destroyed a link the owner had already
        // handed out, over a change that was not about that link.
        expect(await plans.setVisibility(coded.id, owner, "public")).toBe(true);
        expect((await plans.findAccess(coded.id))?.shareCodeHash).toBe(
          "d".repeat(64),
        );
      });

      test("a null hash clears the code, even on a public row", async () => {
        const owner = await fixture.seedUser();
        // Straight to a public row carrying a code - the state a flip now
        // leaves behind - so the clear itself is what is being tested.
        const legacy = row(owner, {
          visibility: "public",
          shareCodeHash: "d".repeat(64),
        });
        await plans.insert(legacy, 10);

        expect(await plans.setShareCodeHash(legacy.id, owner, null)).toBe(true);
        expect((await plans.findAccess(legacy.id))?.shareCodeHash).toBeNull();
      });

      /**
       * The whole of issue #22: an owner opens a code-shared plan up, closes it
       * again, and the link already handed out still works. Nothing writes the
       * hash by hand between the flips - the transitions are what is on trial.
       */
      test("a code survives a round trip through public", async () => {
        const owner = await fixture.seedUser();
        const coded = row(owner, {
          visibility: "private",
          shareCodeHash: "e".repeat(64),
        });
        await plans.insert(coded, 10);

        expect(await plans.setVisibility(coded.id, owner, "public")).toBe(true);
        // Still there while public, where it gates nothing: access is granted
        // on `visibility` before the hash is read.
        expect((await plans.findAccess(coded.id))?.shareCodeHash).toBe(
          "e".repeat(64),
        );

        expect(await plans.setVisibility(coded.id, owner, "private")).toBe(
          true,
        );
        expect(await plans.findAccess(coded.id)).toEqual({
          ownerId: owner,
          visibility: "private",
          shareCodeHash: "e".repeat(64),
        });
      });

      test("a plan that was already private keeps its code", async () => {
        const owner = await fixture.seedUser();
        const coded = row(owner, {
          visibility: "private",
          shareCodeHash: "f".repeat(64),
        });
        await plans.insert(coded, 10);

        // Setting private on a code-shared plan is the idempotent write the
        // sharing editor makes, and it must not be the thing that destroys the
        // code - `DELETE /share-code` is that request.
        expect(await plans.setVisibility(coded.id, owner, "private")).toBe(
          true,
        );
        expect((await plans.findAccess(coded.id))?.shareCodeHash).toBe(
          "f".repeat(64),
        );
      });

      /**
       * A grant is read access and nothing else. Every management call is
       * owner-scoped, so a grantee has to be refused by the same clause a
       * stranger is - otherwise being shared a plan would let you re-share
       * it, take its code, or hand it to someone else.
       */
      test("a grantee may read the plan but may not manage it", async () => {
        const owner = await fixture.seedUser();
        const handle = uniqueHandle();
        const grantee = await fixture.seedUser(handle);
        // A real account, so the handle lookup succeeds and the ownership
        // clause is what refuses below. An unseeded handle would come back
        // "no-user" and prove nothing about ownership.
        const outsiderHandle = uniqueHandle();
        await fixture.seedUser(outsiderHandle);
        const created = row(owner);
        await plans.insert(created, 10);
        expect(await plans.grantByHandle(created.id, owner, handle)).toBe(
          "granted",
        );

        // The read side works: this is what the grant is for.
        expect(await plans.hasGrant(created.id, grantee)).toBe(true);

        expect(await plans.setVisibility(created.id, grantee, "public")).toBe(
          false,
        );
        expect(
          await plans.setShareCodeHash(created.id, grantee, "f".repeat(64)),
        ).toBe(false);
        expect(await plans.listGrantHandles(created.id, grantee)).toBeNull();
        expect(
          await plans.grantByHandle(created.id, grantee, outsiderHandle),
        ).toBe("no-plan");
        expect(await plans.revokeByHandle(created.id, grantee, handle)).toBe(
          false,
        );

        // Nothing moved, and the grantee is still granted.
        expect(await plans.findAccess(created.id)).toEqual({
          ownerId: owner,
          visibility: "private",
          shareCodeHash: null,
        });
        expect(await plans.listGrantHandles(created.id, owner)).toEqual([
          handle,
        ]);
      });

      test("neither setter invents a row for an unknown plan", async () => {
        const userId = await fixture.seedUser();
        const ghost = newPlanId(16);
        expect(await plans.setVisibility(ghost, userId, "public")).toBe(false);
        expect(await plans.setShareCodeHash(ghost, userId, "e")).toBe(false);
        expect(await fixture.countPlans(userId)).toBe(0);
      });
    });

    describe("grants", () => {
      test("an unknown handle is distinguishable from an unowned plan", async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const handle = uniqueHandle();
        await fixture.seedUser(handle);
        const created = row(owner);
        await plans.insert(created, 10);

        // Three outcomes, because the caller renders three messages.
        expect(
          await plans.grantByHandle(created.id, owner, uniqueHandle()),
        ).toBe("no-user");
        expect(await plans.grantByHandle(created.id, stranger, handle)).toBe(
          "no-plan",
        );
        expect(await plans.grantByHandle(newPlanId(16), owner, handle)).toBe(
          "no-plan",
        );
        // Both wrong at once: ownership is settled first, so this is
        // "no-plan". Pinned because the two dialects run different SQL and a
        // silent disagreement here would surface as a different error message
        // depending on which database a deployment uses - and because the
        // order is the security property: a caller who does not own the plan
        // learns nothing further, not even which of the two they got wrong.
        expect(
          await plans.grantByHandle(newPlanId(16), stranger, uniqueHandle()),
        ).toBe("no-plan");
        expect(await plans.grantByHandle(created.id, owner, handle)).toBe(
          "granted",
        );
      });

      test("granting the same handle twice is idempotent", async () => {
        const owner = await fixture.seedUser();
        const handle = uniqueHandle();
        const grantee = await fixture.seedUser(handle);
        const created = row(owner);
        await plans.insert(created, 10);

        expect(await plans.grantByHandle(created.id, owner, handle)).toBe(
          "granted",
        );
        // The second call must not report a failure the caller would surface
        // as an error; the state it asks for already holds.
        expect(await plans.grantByHandle(created.id, owner, handle)).toBe(
          "granted",
        );
        expect(await plans.listGrantHandles(created.id, owner)).toEqual([
          handle,
        ]);
        expect(await plans.hasGrant(created.id, grantee)).toBe(true);
      });

      test("an account id names the same account as its handle", async () => {
        // The dashboard shows a handle, but `/api/auth/get-session` hands the
        // signed-in account its id, so an API caller may hold either.
        const owner = await fixture.seedUser();
        const handle = uniqueHandle();
        const grantee = await fixture.seedUser(handle);
        const created = row(owner);
        await plans.insert(created, 10);

        expect(await plans.grantByHandle(created.id, owner, grantee)).toBe(
          "granted",
        );
        expect(await plans.hasGrant(created.id, grantee)).toBe(true);
        // Listing still answers in handles: that is the identifier a person
        // can read off their own dashboard.
        expect(await plans.listGrantHandles(created.id, owner)).toEqual([
          handle,
        ]);

        expect(await plans.revokeByHandle(created.id, owner, grantee)).toBe(
          true,
        );
        expect(await plans.hasGrant(created.id, grantee)).toBe(false);
      });

      /**
       * The two identifiers live in different columns, so a token could match
       * one account by id and a different one by handle. Matching both would
       * have granted an account the owner never named.
       */
      test("an id that is also someone's handle grants only the id's owner", async () => {
        const owner = await fixture.seedUser();
        const byId = await fixture.seedUser();
        // A renamed account whose handle is now the other account's id.
        const byHandle = await fixture.seedUser(byId);
        const created = row(owner);
        await plans.insert(created, 10);

        expect(await plans.grantByHandle(created.id, owner, byId)).toBe(
          "granted",
        );
        expect(await plans.hasGrant(created.id, byId)).toBe(true);
        // The collision: this account must not have been swept up.
        expect(await plans.hasGrant(created.id, byHandle)).toBe(false);
      });

      test("a grant is scoped to its own plan and its own account", async () => {
        const owner = await fixture.seedUser();
        const handle = uniqueHandle();
        const grantee = await fixture.seedUser(handle);
        const outsider = await fixture.seedUser();
        const granted = row(owner);
        const other = row(owner);
        await plans.insert(granted, 10);
        await plans.insert(other, 10);
        await plans.grantByHandle(granted.id, owner, handle);

        expect(await plans.hasGrant(granted.id, grantee)).toBe(true);
        expect(await plans.hasGrant(other.id, grantee)).toBe(false);
        expect(await plans.hasGrant(granted.id, outsider)).toBe(false);
      });

      test("revoke removes once, then reports nothing to remove", async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const handle = uniqueHandle();
        const grantee = await fixture.seedUser(handle);
        const created = row(owner);
        await plans.insert(created, 10);
        await plans.grantByHandle(created.id, owner, handle);

        // A stranger must not be able to strip somebody else's grants.
        expect(await plans.revokeByHandle(created.id, stranger, handle)).toBe(
          false,
        );
        expect(await plans.hasGrant(created.id, grantee)).toBe(true);

        expect(await plans.revokeByHandle(created.id, owner, handle)).toBe(
          true,
        );
        expect(await plans.revokeByHandle(created.id, owner, handle)).toBe(
          false,
        );
        expect(
          await plans.revokeByHandle(created.id, owner, uniqueHandle()),
        ).toBe(false);
        expect(await plans.hasGrant(created.id, grantee)).toBe(false);
      });

      test("listGrantHandles separates no grants from no plan", async () => {
        const owner = await fixture.seedUser();
        const stranger = await fixture.seedUser();
        const created = row(owner);
        await plans.insert(created, 10);

        // Empty is a real answer; null is a refusal.
        expect(await plans.listGrantHandles(created.id, owner)).toEqual([]);
        expect(await plans.listGrantHandles(created.id, stranger)).toBeNull();
        expect(await plans.listGrantHandles(newPlanId(16), owner)).toBeNull();
      });

      test("listGrantHandles reports only the plan it was asked about", async () => {
        const owner = await fixture.seedUser();
        const [oneHandle, twoHandle] = [uniqueHandle(), uniqueHandle()];
        await fixture.seedUser(oneHandle);
        await fixture.seedUser(twoHandle);
        const one = row(owner);
        const two = row(owner);
        await plans.insert(one, 10);
        await plans.insert(two, 10);
        await plans.grantByHandle(one.id, owner, oneHandle);
        await plans.grantByHandle(two.id, owner, twoHandle);

        // Both plans belong to the same owner, so only the `plan_id` filter
        // separates them - a query that dropped it would still pass every
        // other assertion in this block.
        expect(await plans.listGrantHandles(one.id, owner)).toEqual([
          oneHandle,
        ]);
        expect(await plans.listGrantHandles(two.id, owner)).toEqual([
          twoHandle,
        ]);
      });

      test("deleting the plan takes its grants with it", async () => {
        const owner = await fixture.seedUser();
        const handle = uniqueHandle();
        const grantee = await fixture.seedUser(handle);
        const created = row(owner);
        await plans.insert(created, 10);
        await plans.grantByHandle(created.id, owner, handle);

        expect(await plans.deleteOwned(created.id, owner)).toBe(true);
        expect(await plans.hasGrant(created.id, grantee)).toBe(false);
      });
    });
  });
}
