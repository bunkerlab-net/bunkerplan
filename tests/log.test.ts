import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { createLogger, redactSecrets } from "../src/log.ts";

describe("redactSecrets", () => {
  test("removes the userinfo from a postgres URL, keeping host and database", () => {
    expect(
      redactSecrets(
        "connect ECONNREFUSED postgres://app:hunter2@db:5432/plans",
      ),
    ).toBe("connect ECONNREFUSED postgres://[redacted]@db:5432/plans");
  });

  test("removes redis and rediss userinfo", () => {
    expect(redactSecrets("redis://default:s3cr3t@valkey:6379")).toBe(
      "redis://[redacted]@valkey:6379",
    );
    expect(redactSecrets("rediss://u:p@host:6380")).toBe(
      "rediss://[redacted]@host:6380",
    );
  });

  test("a password containing @ cannot leak its tail", () => {
    // Matching to the FIRST `@` would emit `postgres://[redacted]@ss@host/db`,
    // leaking `ss`. The match runs to the last `@` before the path instead.
    expect(redactSecrets("postgres://u:p@ss@host/db")).toBe(
      "postgres://[redacted]@host/db",
    );
    expect(redactSecrets("redis://user:a@b@c@valkey:6379/0")).toBe(
      "redis://[redacted]@valkey:6379/0",
    );
  });

  test("a password containing : cannot leak", () => {
    expect(redactSecrets("postgres://u:pa:ss:word@host/db")).toBe(
      "postgres://[redacted]@host/db",
    );
  });

  test("removes a bare username with no password", () => {
    expect(redactSecrets("postgres://solouser@host/db")).toBe(
      "postgres://[redacted]@host/db",
    );
  });

  test("redacts every occurrence without spanning between them", () => {
    expect(redactSecrets("a postgres://u:p1@h/db b redis://v:p2@h")).toBe(
      "a postgres://[redacted]@h/db b redis://[redacted]@h",
    );
  });

  test("handles URL-encoded passwords", () => {
    expect(redactSecrets("postgres://u:p%40ss%3Aword@h/db")).toBe(
      "postgres://[redacted]@h/db",
    );
  });

  test("leaves credential-free URLs alone", () => {
    const clean = "GET https://plans.example.com/abc123 failed with 502";
    expect(redactSecrets(clean)).toBe(clean);
    expect(redactSecrets("postgres://db:5432/plans")).toBe(
      "postgres://db:5432/plans",
    );
  });

  test("does not treat an @ in a path or query as userinfo", () => {
    expect(redactSecrets("https://host/path@x")).toBe("https://host/path@x");
    expect(redactSecrets("https://host/?to=a@b.com")).toBe(
      "https://host/?to=a@b.com",
    );
  });

  test("leaves ordinary text alone", () => {
    expect(redactSecrets("plan upload failed")).toBe("plan upload failed");
    expect(redactSecrets("user a@b.com signed in")).toBe(
      "user a@b.com signed in",
    );
  });
});

const BASE_ENV = {
  BETTER_AUTH_SECRET: "x".repeat(40),
  PUBLIC_BASE_URL: "http://localhost:3000",
  STORAGE_DRIVER: "s3",
  S3_BUCKET: "b",
  DB_DRIVER: "postgres",
  DATABASE_URL: "postgres://x",
  KV_DRIVER: "valkey",
  VALKEY_URL: "redis://x",
};

/** Captures what the logger actually writes to the console. */
function capture(
  format: "json" | "plain",
  emit: (log: ReturnType<typeof createLogger>) => void,
): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => {
    lines.push(line);
  };
  try {
    emit(createLogger(loadConfig({ ...BASE_ENV, LOG_FORMAT: format })));
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

describe("createLogger redaction", () => {
  for (const format of ["json", "plain"] as const) {
    test(`${format}: censors a password in an error message and stack`, () => {
      const output = capture(format, (log) => {
        const err = new Error(
          "getaddrinfo ENOTFOUND postgres://app:hunter2@db.internal:5432/plans",
        );
        err.stack =
          "Error: connect failed postgres://app:hunter2@db.internal:5432/plans\n    at Client.connect";
        log.error({ err, check: "db" }, "probe failed");
      });
      expect(output).not.toContain("hunter2");
      expect(output).toContain("[redacted]");
      // Everything that makes the failure diagnosable survives.
      expect(output).toContain("ENOTFOUND");
      expect(output).toContain("db.internal:5432");
      expect(output).toContain("probe failed");
    });

    test(`${format}: censors credential-bearing keys`, () => {
      const output = capture(format, (log) => {
        log.error(
          { password: "hunter2", config: { secretAccessKey: "AKIAsecret" } },
          "probe failed",
        );
      });
      expect(output).not.toContain("hunter2");
      expect(output).not.toContain("AKIAsecret");
      expect(output).toContain("[redacted]");
    });
  }

  test("json: still emits a parseable ECS line", () => {
    const output = capture("json", (log) => {
      log.info({ planId: "abc" }, "plan uploaded");
    });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed["message"]).toBe("plan uploaded");
    expect(parsed["log.level"]).toBe("info");
    expect(parsed["planId"]).toBe("abc");
  });
});
