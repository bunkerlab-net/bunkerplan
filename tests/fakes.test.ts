import { describe, expect, test } from "bun:test";
import {
  closedRateLimits,
  openAccounts,
  openRateLimits,
} from "./app-harness.ts";
import { at, recordingLogger } from "./fakes.ts";
import { basePlanRepoStub } from "./plan-repo-stub.ts";

/**
 * The shared fakes' own contracts, where a suite depending on one would not
 * notice it breaking.
 *
 * `recordingLogger` is the case that earned this file. Several suites assert
 * on `fields`, and a fake that quietly records an empty object makes all of
 * them pass by agreeing with themselves - the assertion and the value are both
 * wrong in the same direction. Nothing else can catch that, because every
 * caller of the fake is a caller that trusts it.
 */
describe("recordingLogger", () => {
  test("records the fields of an object call", () => {
    const { logger, lines } = recordingLogger();

    logger.warn({ userId: "u1", planId: "p1" }, "swept");

    expect(at(lines, "warn")).toEqual([
      {
        level: "warn",
        fields: { userId: "u1", planId: "p1" },
        message: "swept",
      },
    ]);
  });

  test("records a message-only call with no fields", () => {
    const { logger, lines } = recordingLogger();

    logger.info("started");

    expect(at(lines, "info")).toEqual([
      { level: "info", fields: {}, message: "started" },
    ]);
  });

  /**
   * The regression. `logger.error(err, "...")` is a shape pino accepts, and
   * the fake used to spread it - which yields `{}`, because none of an
   * Error's standard fields survive a spread: `message` and `stack` are own
   * but not enumerable, and `name` usually comes off the prototype. A suite
   * asserting `fields` on such a line saw nothing and was satisfied, while
   * production logged the error in full.
   */
  test("records an Error passed as the first argument", () => {
    const { logger, lines } = recordingLogger();
    const failure = Object.assign(new Error("bucket unreachable"), {
      code: "ECONNREFUSED",
    });

    logger.error(failure, "delete failed");

    const [line] = at(lines, "error");
    expect(line?.message).toBe("delete failed");
    expect(line?.fields).toMatchObject({
      name: "Error",
      message: "bucket unreachable",
      // The enumerable extras a driver hangs on its errors travel too - the
      // SQLSTATE on a `pg` error is one of these, and it is the field most
      // worth asserting on.
      code: "ECONNREFUSED",
    });
    expect(line?.fields["stack"]).toContain("bucket unreachable");
  });
});

/**
 * The inert sharing stub, whose whole value is the answers it gives.
 *
 * Suites that have nothing to do with sharing spread this to satisfy
 * `PlanRepo`, and every method answers negatively on purpose: a handler that
 * unexpectedly reaches into sharing gets "no", rather than a convenient
 * success that would let the test pass for the wrong reason.
 *
 * Nothing calls these, which is exactly why they are worth pinning. One of
 * them flipped to a positive answer - `hasGrant` returning true, say - would
 * turn a suite full of ownership assertions green without any of them
 * exercising the thing they name, and no other test in the repo would fail.
 */
describe("basePlanRepoStub", () => {
  /*
   * Called with no arguments, which is how they are declared: each ignores
   * what it is asked, so widening the signatures to accept a plan id would be
   * adding surface the stub does not have in order to pass it values it would
   * not read.
   */
  test("refuses every question it is asked", async () => {
    expect(await basePlanRepoStub.findAccess()).toBeNull();
    expect(await basePlanRepoStub.hasGrant()).toBe(false);
    expect(await basePlanRepoStub.setVisibility()).toBe(false);
    expect(await basePlanRepoStub.setShareCodeHash()).toBe(false);
    expect(await basePlanRepoStub.listGrantHandles()).toBeNull();
    expect(await basePlanRepoStub.revokeByHandle()).toBe(false);
  });

  /**
   * The one that is not a boolean. `grantByHandle` answers with a reason, and
   * "no-plan" is the negative one - anything else here would hand a suite a
   * grant it never set up.
   */
  test("grants nothing, and says which negative answer it is", async () => {
    expect(await basePlanRepoStub.grantByHandle()).toBe("no-plan");
  });
});

/**
 * The harness's own limiters and closing marker.
 *
 * Every suite built on `buildApp` gets these by default, and each one is a
 * single word of behaviour that dozens of assertions quietly stand on: the
 * upload tests mean something because `openRateLimits` allows, the throttle
 * tests mean something because `closedRateLimits` refuses, and every upload
 * assertion means something because `openAccounts` reports nothing closing.
 *
 * Flip any one of them and the suites do not fail - they pass without
 * exercising what they name. `closedRateLimits.consume` answering `allowed`
 * would turn every 429 assertion into a 200 the tests never asked about, and
 * `openAccounts.isOpen` answering true would make every upload path return
 * `409` while the tests that care about 409 kept passing too.
 */
describe("the harness fixtures", () => {
  test("openRateLimits allows, and gives back what it never charged", async () => {
    expect(await openRateLimits.consume("k", 1, 60)).toMatchObject({
      allowed: true,
    });
    // Refunding is a no-op rather than an error: handlers refund on their
    // success paths, and a fixture that threw there would fail the suites
    // that are about the success rather than about the counter.
    expect(await openRateLimits.refund("k", 0)).toBeUndefined();
  });

  test("closedRateLimits refuses, and names a wait", async () => {
    const result = await closedRateLimits.consume("k", 1, 60);

    expect(result.allowed).toBe(false);
    // A 429 with no `retry-after` is a refusal a caller cannot act on, and
    // several suites assert the header rather than only the status.
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(await closedRateLimits.refund("k", 0)).toBeUndefined();
  });

  test("openAccounts reports nothing closing", async () => {
    // The marker every upload checks. `true` here would answer `409 account
    // is being deleted` on paths no upload suite is testing for.
    expect(await openAccounts.isOpen("user-a")).toBe(false);
    expect(await openAccounts.open("user-a")).toBe("attempt");
    expect(await openAccounts.close("attempt")).toBeUndefined();
  });
});
