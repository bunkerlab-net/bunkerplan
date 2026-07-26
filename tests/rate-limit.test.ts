import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createSqliteRateLimitRepo } from "../src/db/rate-limits.sqlite.ts";
import { sqliteSchema } from "../src/db/sqlite-shared.ts";
import type { RateLimitRepo } from "../src/services/types.ts";

const WINDOW = 60;
const MAX = 3;

let handle: Database;
let repo: RateLimitRepo;

beforeEach(() => {
  handle = new Database(":memory:");
  // Foreign keys are OFF by default per connection, so without this the
  // cascade below would silently do nothing — exactly the bug being guarded.
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec(`CREATE TABLE user (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  handle.exec(`CREATE TABLE upload_rate_limit (
    key TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    count INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  )`);
  repo = createSqliteRateLimitRepo(drizzle(handle, { schema: sqliteSchema }));
});

function ensureUser(id: string) {
  handle
    .query("INSERT OR IGNORE INTO user (id, name, email) VALUES (?, ?, ?)")
    .run(id, id, `${id}@test.invalid`);
}

const consume = (key: string, max = MAX) => {
  ensureUser(key);
  return repo.consume(key, max, WINDOW);
};

/** Backdates the stored window so the next call sees it as elapsed. */
function ageOutWindow(key: string) {
  handle
    .query("UPDATE upload_rate_limit SET window_start = ? WHERE key = ?")
    .run(Date.now() - (WINDOW + 1) * 1000, key);
}

/** Reads a single numeric column aliased `v`, checked rather than asserted. */
function scalar(sql: string): number {
  const row = handle.query(sql).get();
  if (row !== null && typeof row === "object" && "v" in row) {
    const value = row.v;
    if (typeof value === "number") return value;
  }
  throw new Error(`expected a numeric column "v" from: ${sql}`);
}

describe("upload rate limit", () => {
  test("allows up to max then refuses", async () => {
    const allowed = [];
    for (let i = 0; i < 5; i += 1) allowed.push((await consume("a")).allowed);
    expect(allowed).toEqual([true, true, true, false, false]);
  });

  test("counts each key separately", async () => {
    for (let i = 0; i < MAX; i += 1) await consume("a");
    expect((await consume("a")).allowed).toBe(false);
    expect((await consume("b")).allowed).toBe(true);
  });

  /**
   * The race a read-then-write limiter loses. Two first requests for one key
   * run before either has written; an implementation that inserts and treats
   * the conflict as a refusal rejects the second even though the count is 1.
   */
  test("concurrent first requests for a new key both count", async () => {
    const first = await Promise.all([consume("new"), consume("new")]);
    expect(first.map((r) => r.allowed)).toEqual([true, true]);

    // Both landed, so exactly one of the three remains.
    expect((await consume("new")).allowed).toBe(true);
    expect((await consume("new")).allowed).toBe(false);
  });

  test("a concurrent burst never exceeds max", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consume("burst", 5)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  test("the window rolls over and the count resets", async () => {
    for (let i = 0; i < MAX; i += 1) await consume("c");
    expect((await consume("c")).allowed).toBe(false);

    ageOutWindow("c");
    expect((await consume("c")).allowed).toBe(true);
    // A rollover restarts the count at 1, so two more fit before the wall.
    expect((await consume("c")).allowed).toBe(true);
    expect((await consume("c")).allowed).toBe(true);
    expect((await consume("c")).allowed).toBe(false);
  });

  test("retryAfter counts down within the window", async () => {
    const first = await consume("d");
    expect(first.retryAfter).toBeGreaterThanOrEqual(1);
    expect(first.retryAfter).toBeLessThanOrEqual(WINDOW);

    for (let i = 0; i < MAX; i += 1) await consume("d");
    const refused = await consume("d");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfter).toBeLessThanOrEqual(WINDOW);
  });

  test("a refusal does not extend the window", async () => {
    const windowOf = () =>
      scalar("SELECT window_start AS v FROM upload_rate_limit WHERE key = 'e'");
    for (let i = 0; i < MAX; i += 1) await consume("e");
    const before = windowOf();

    await consume("e");
    expect(windowOf()).toBe(before);
  });

  /**
   * Nothing prunes this table, so a counter left behind by a deleted account
   * would sit there for good. `plan` cascades the same way.
   */
  test("deleting the user removes the counter", async () => {
    const rows = () =>
      scalar("SELECT count(*) AS v FROM upload_rate_limit WHERE key = 'gone'");
    await consume("gone");
    expect(rows()).toBe(1);

    handle.query("DELETE FROM user WHERE id = 'gone'").run();
    expect(rows()).toBe(0);
  });
});
