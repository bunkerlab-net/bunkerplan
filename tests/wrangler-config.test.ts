import { describe, expect, test } from "bun:test";
import {
  deployConfigProblems,
  isLoopback,
  type WranglerConfig,
} from "../scripts/check-deploy-config.ts";
import wrangler from "../wrangler.jsonc";

/**
 * The deploy gate's own suite.
 *
 * The checks live in scripts/check-deploy-config.ts because `bun run
 * deploy:check` runs them before the D1 migrations, outside the test runner -
 * see the note there. This file is the other half: the whole suite covers them
 * on every commit, off one set of functions rather than a second copy free to
 * drift.
 *
 * Both directions are here on purpose. Asserting only that the committed file
 * passes would leave a gate that has never refused anything - it would still
 * read as green with every check deleted.
 *
 * A localhost `PUBLIC_BASE_URL` is the sharp one: `origin` in
 * src/auth/options.ts is pinned to it and WebAuthn compares the relying-party
 * origin to the browser's exactly, so a Worker shipped with the dev value
 * serves a site where every passkey ceremony fails and no other way in exists.
 */

const config = wrangler as WranglerConfig;

/** The committed file, with one thing wrong. */
function broken(change: Partial<WranglerConfig>): WranglerConfig {
  return { ...config, ...change };
}

describe("the deployed wrangler configuration", () => {
  test("ships with nothing wrong with it", () => {
    expect(deployConfigProblems(config)).toEqual([]);
  });

  test("binds them under the names the runtime reaches for", () => {
    const names = (entries: { binding: string }[] | undefined) =>
      (entries ?? []).map((entry) => entry.binding);

    expect(names(config.d1_databases)).toEqual(["DB"]);
    expect(names(config.kv_namespaces)).toEqual(["KV"]);
    expect(names(config.r2_buckets)).toEqual(["BUCKET"]);
  });
});

describe("the gate refuses", () => {
  test.each([
    ["http://plan.bunkerlab.net", "is not https"],
    ["https://localhost:3000", "names this machine"],
    ["https://127.0.0.2", "names this machine"],
    ["", "is not https"],
    // Passes the prefix check and then fails to parse. Reported, not raised:
    // a throw here would hide every other fault in the same file.
    ["https://[", "is not a URL"],
  ])("a PUBLIC_BASE_URL of %p", (base, reason) => {
    const problems = deployConfigProblems(
      broken({ vars: { ...config.vars, PUBLIC_BASE_URL: base } }),
    );

    expect(problems.join("\n")).toContain(reason);
  });

  /**
   * Nothing in the file at all, which is the shape that proves the report is
   * a list rather than a throw: every check has to survive the one before it
   * finding nothing to read.
   */
  test("a file with none of the blocks it needs", () => {
    const problems = deployConfigProblems({});

    expect(problems).toContain("PUBLIC_BASE_URL is not https: (unset)");
    expect(problems).toContain("no d1_databases are bound");
    expect(problems).toContain("no kv_namespaces are bound");
    expect(problems.join("\n")).toContain("expected one binding named BUCKET");
  });

  test("the placeholder ids a fresh clone carries", () => {
    const problems = deployConfigProblems(
      broken({
        d1_databases: [
          {
            binding: "DB",
            database_id: "00000000-0000-0000-0000-000000000000",
          },
        ],
        kv_namespaces: [{ binding: "KV", id: "0".repeat(32) }],
      }),
    );

    expect(problems).toContain("D1 id is the placeholder");
    expect(problems).toContain("KV id is the placeholder");
  });

  test.each([
    ["not-a-uuid", "D1 id is not a uuid"],
    ["0000000-0000-0000-0000-000000000000", "D1 id is not a uuid"],
  ])("a D1 id of %p", (id, reason) => {
    const problems = deployConfigProblems(
      broken({ d1_databases: [{ binding: "DB", database_id: id }] }),
    );

    expect(problems.join("\n")).toContain(reason);
  });

  test("a KV id that is not a namespace id", () => {
    const problems = deployConfigProblems(
      broken({ kv_namespaces: [{ binding: "KV", id: "nope" }] }),
    );

    expect(problems.join("\n")).toContain("KV id is not a namespace id");
  });

  /**
   * Deleted blocks, which is the case `?? []` exists for: the report has to
   * name what is absent rather than throw a `TypeError` reading `.map` of
   * undefined.
   */
  test("binding blocks that were deleted by hand", () => {
    const problems = deployConfigProblems({ vars: config.vars });

    expect(problems).toContain("no d1_databases are bound");
    expect(problems).toContain("no kv_namespaces are bound");
    expect(problems.join("\n")).toContain("expected one binding named BUCKET");
  });

  /**
   * Real ids under names nothing reads - the failure the id checks above are
   * blind to, and a Worker that deploys clean then fails on first request.
   */
  test("bindings renamed away from what the runtime reads", () => {
    const problems = deployConfigProblems(
      broken({
        d1_databases: [
          {
            binding: "DATABASE",
            database_id: config.d1_databases?.[0]?.database_id ?? "",
          },
        ],
      }),
    );

    expect(problems.join("\n")).toContain("expected one binding named DB");
  });

  test("vars the Worker's own loader would reject at boot", () => {
    const problems = deployConfigProblems(
      broken({ vars: { ...config.vars, UPLOAD_RATE_MAX: 0 } }),
    );

    expect(problems.join("\n")).toContain("fail the Worker's own validation");
  });
});

describe("this machine, in every spelling a URL keeps", () => {
  test.each([
    "localhost",
    "localhost.",
    "sub.localhost",
    "127.0.0.1",
    "127.0.0.2",
    "0x7f000001",
    "2130706433",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:127.0.0.2]",
    // Unspecified rather than loopback, and caught for the same reason.
    "0.0.0.0",
    "[::]",
  ])("%s is recognised", (host) => {
    // The predicate is only worth as much as its coverage, and several of
    // these reach it already rewritten by `new URL()`.
    expect(isLoopback(new URL(`https://${host}/`).hostname)).toBe(true);
  });

  test.each(["plan.bunkerlab.net", "plan.bunkerlab.net.", "127x0x0x1.example"])(
    "%s is not",
    (host) => {
      expect(isLoopback(new URL(`https://${host}/`).hostname)).toBe(false);
    },
  );
});
