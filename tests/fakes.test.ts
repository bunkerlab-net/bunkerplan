import { describe, expect, test } from "bun:test";
import { at, recordingLogger } from "./fakes.ts";

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
   * the fake used to spread it - which yields `{}`, because an Error's `name`,
   * `message`, and `stack` are own properties but not enumerable. A suite
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
