import { describe, expect, test } from "bun:test";
import { pino } from "pino";
import { healthz } from "../src/http/healthz.ts";
import type { Db, KvStore, PlanStorage } from "../src/services/types.ts";
import { basePlanRepoStub } from "./plan-repo-stub.ts";

/** Silent: these tests assert on responses and side effects, not on output. */
const logger = pino({ level: "silent" });

interface Fakes {
  services: () => Promise<{
    storage: PlanStorage;
    db: Db;
    kv: KvStore;
    logger: typeof logger;
  }>;
  probed: string[];
}

function fakes(fails: string[] = []): Fakes {
  const probed: string[] = [];
  const probe = (name: string) => async () => {
    probed.push(name);
    if (fails.includes(name)) throw new Error(`${name} unreachable`);
  };

  const storage = {
    put: async () => {},
    get: async () => null,
    delete: async () => {},
    probe: probe("storage"),
  } satisfies PlanStorage;

  const kv = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    probe: probe("kv"),
  } satisfies KvStore;

  const db = {
    adapter: {},
    provider: "pg",
    plans: {
      ...basePlanRepoStub,
      insert: async () => "created",
      listByUser: async () => [],
      findOwner: async () => null,
      relabel: async () => false,
      resize: async () => false,
      deleteOwned: async () => false,
    },
    uploadRateLimits: {
      consume: async () => ({ allowed: true, retryAfter: 60 }),
      peek: async () => ({ allowed: true, retryAfter: 60 }),
    },
    unlockRateLimits: {
      consume: async () => ({ allowed: true, retryAfter: 60 }),
      peek: async () => ({ allowed: true, retryAfter: 60 }),
    },
    accountClosing: {
      open: async () => {},
      isOpen: async () => false,
    },
    probe: probe("db"),
  } satisfies Db;

  return {
    services: async () => ({ storage, db, kv, logger }),
    probed,
  };
}

/** The documented body shape; `Response.json()` erases it to `unknown`. */
interface Health {
  status: string;
  checks: Record<string, string>;
}

describe("healthz", () => {
  test("200 with every check ok when all three probes pass", async () => {
    const { services, probed } = fakes();
    const response = await healthz("node", services);
    expect(response.status).toBe(200);
    expect((await response.json()) as Health).toEqual({
      status: "ok",
      checks: { storage: "ok", db: "ok", kv: "ok" },
    });
    expect(probed.sort()).toEqual(["db", "kv", "storage"]);
  });

  test("503 naming only the failed checks", async () => {
    const { services } = fakes(["db", "kv"]);
    const response = await healthz("node", services);
    expect(response.status).toBe(503);
    expect((await response.json()) as Health).toEqual({
      status: "error",
      checks: { storage: "ok", db: "error", kv: "error" },
    });
  });

  test("never puts the driver error in the body", async () => {
    const { services } = fakes(["db"]);
    const body = await (await healthz("node", services)).text();
    expect(body).not.toContain("unreachable");
  });

  test("404s on Workers without resolving services at all", async () => {
    // The invariant this endpoint exists to protect on Workers: no request may
    // reach a binding, because each probe is a billable operation and the route
    // is public. Throwing from the getter fails the test if it is ever called.
    let resolved = false;
    const response = await healthz("cloudflare", () => {
      resolved = true;
      throw new Error("services must not be initialised on Workers");
    });
    expect(response.status).toBe(404);
    expect(resolved).toBe(false);
    expect(await response.text()).toBe("Not found");
  });
});
