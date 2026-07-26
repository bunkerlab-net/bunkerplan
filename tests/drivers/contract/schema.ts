import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type DbFixture, FIXTURE_TIMEOUT_MS } from "../backends.ts";

/**
 * Constraints that live in the migrations rather than in any repository, run
 * against D1, bun:sqlite, and Postgres.
 *
 * `drizzle/sqlite` and `drizzle/pg` are separately generated artifacts. A
 * constraint added to one and missed in the other is invisible to every suite
 * that goes through a repository, because no repository statement mentions it.
 */

export function describeSchema(
  name: string,
  open: () => Promise<DbFixture>,
  options: { skip: boolean },
): void {
  describe.skipIf(options.skip)(`schema: ${name}`, () => {
    let fixture: DbFixture;

    beforeAll(async () => {
      fixture = await open();
    }, FIXTURE_TIMEOUT_MS);

    afterAll(async () => {
      await fixture.close();
    }, FIXTURE_TIMEOUT_MS);

    /**
     * Registration takes no attestation, so a credential id carries no
     * signature and is chosen by whoever registers. Sign-in looks a credential
     * up by that id and verifies the assertion against whichever row comes
     * back, so a second account claiming a victim's id makes that lookup a coin
     * toss - and the victim, who has no password and no email recovery, can be
     * locked out permanently. The database is what has to refuse it.
     */
    test("a passkey credential id cannot be claimed twice", async () => {
      const victim = await fixture.seedUser();
      const attacker = await fixture.seedUser();
      const credentialId = `cred-${crypto.randomUUID()}`;

      await fixture.addPasskey(victim, credentialId);
      await expect(
        fixture.addPasskey(attacker, credentialId),
      ).rejects.toThrow();

      expect(await fixture.countPasskeys(victim)).toBe(1);
      expect(await fixture.countPasskeys(attacker)).toBe(0);
    });

    test("the same account cannot register one credential twice either", async () => {
      const owner = await fixture.seedUser();
      const credentialId = `cred-${crypto.randomUUID()}`;

      await fixture.addPasskey(owner, credentialId);
      await expect(fixture.addPasskey(owner, credentialId)).rejects.toThrow();
      expect(await fixture.countPasskeys(owner)).toBe(1);
    });

    test("one account may still hold several distinct credentials", async () => {
      const owner = await fixture.seedUser();
      // A phone and a laptop is the ordinary case; the constraint above must
      // not be the reason a second device cannot be added.
      await fixture.addPasskey(owner, `cred-${crypto.randomUUID()}`);
      await fixture.addPasskey(owner, `cred-${crypto.randomUUID()}`);
      expect(await fixture.countPasskeys(owner)).toBe(2);
    });

    test("a passkey cannot be attached to an account that does not exist", async () => {
      await expect(
        fixture.addPasskey(`ghost-${crypto.randomUUID()}`, "cred-orphan"),
      ).rejects.toThrow();
    });

    test("deleting the account takes its passkeys with it", async () => {
      const owner = await fixture.seedUser();
      await fixture.addPasskey(owner, `cred-${crypto.randomUUID()}`);
      await fixture.addPasskey(owner, `cred-${crypto.randomUUID()}`);

      // Otherwise a deleted account leaves credentials that still resolve on
      // sign-in, pointing at a user row that is gone.
      await fixture.deleteUser(owner);
      expect(await fixture.countPasskeys(owner)).toBe(0);
    });

    test("a credential id freed by deletion can be registered again", async () => {
      const first = await fixture.seedUser();
      const credentialId = `cred-${crypto.randomUUID()}`;
      await fixture.addPasskey(first, credentialId);
      await fixture.deleteUser(first);

      const second = await fixture.seedUser();
      await fixture.addPasskey(second, credentialId);
      expect(await fixture.countPasskeys(second)).toBe(1);
    });
  });
}
