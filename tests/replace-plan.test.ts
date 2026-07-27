import { describe, expect, test } from "bun:test";
import { pino } from "pino";
import { replacePlan } from "../src/http/replace-plan.ts";
import type { PlanRepo, PlanStorage } from "../src/services/types.ts";

const OWNER = "user-a";
const OTHER = "user-b";
const ID = "plan-1";

const CONFIG = {
  maxUploadBytes: 2 * 1024 * 1024,
  publicBaseUrl: "https://plans.example.test",
};

const HTML = "<!doctype html><html><body><p>new</p></body></html>";

/** Silent: these tests assert on responses and side effects, not on output. */
const logger = pino({ level: "silent" });

interface Written {
  objects: { key: string; size: number }[];
  sizes: number[];
  removed: string[];
}

function fakes(
  options: {
    owner?: string | null;
    /** A row deleted between the ownership check and the size update. */
    rowVanishes?: boolean;
    storageFails?: boolean;
  } = {},
) {
  const owner = options.owner === undefined ? OWNER : options.owner;
  const written: Written = { objects: [], sizes: [], removed: [] };

  const storage: PlanStorage = {
    put: async (key, body) => {
      if (options.storageFails === true) throw new Error("bucket unreachable");
      written.objects.push({ key, size: body.byteLength });
    },
    get: async () => null,
    delete: async (key) => {
      written.removed.push(key);
    },
    probe: async () => {},
  };

  const plans: PlanRepo = {
    insert: async () => "created",
    listByUser: async () => [],
    findOwner: async () => owner,
    relabel: async () => false,
    resize: async (id, userId, size) => {
      if (options.rowVanishes === true) return false;
      if (id !== ID || userId !== owner) return false;
      written.sizes.push(size);
      return true;
    },
    deleteOwned: async () => false,
    findAccess: async () => null,
    hasGrant: async () => false,
    setVisibility: async () => false,
    setShareCodeHash: async () => false,
    listGrantHandles: async () => null,
    grantByHandle: async () => "no-plan",
    revokeByHandle: async () => false,
  };

  return { storage, plans, written };
}

function put(body = HTML): Request {
  return new Request(`https://example.test/api/plans/${ID}`, {
    method: "PUT",
    headers: { "content-type": "text/html" },
    body,
  });
}

describe("replacePlan", () => {
  test("writes the object, records the size, and echoes the unchanged URL", async () => {
    const { storage, plans, written } = fakes();
    const response = await replacePlan(
      storage,
      plans,
      logger,
      put(),
      ID,
      OWNER,
      CONFIG,
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string; url: string }).toEqual({
      id: ID,
      url: `${CONFIG.publicBaseUrl}/p/${ID}`,
    });
    expect(written.objects).toEqual([{ key: ID, size: HTML.length }]);
    expect(written.sizes).toEqual([HTML.length]);
  });

  test("404s for another account's plan without touching its object", async () => {
    const { storage, plans, written } = fakes();
    const response = await replacePlan(
      storage,
      plans,
      logger,
      put(),
      ID,
      OTHER,
      CONFIG,
    );

    expect(response.status).toBe(404);
    expect(written).toEqual({ objects: [], sizes: [], removed: [] });
  });

  test("404s for an unknown id", async () => {
    const { storage, plans, written } = fakes({ owner: null });
    const response = await replacePlan(
      storage,
      plans,
      logger,
      put(),
      ID,
      OWNER,
      CONFIG,
    );

    expect(response.status).toBe(404);
    expect(written.objects).toEqual([]);
  });

  test("takes the object back out when the row goes away underneath it", async () => {
    const { storage, plans, written } = fakes({ rowVanishes: true });
    const response = await replacePlan(
      storage,
      plans,
      logger,
      put(),
      ID,
      OWNER,
      CONFIG,
    );

    expect(response.status).toBe(404);
    expect(written.sizes).toEqual([]);
    // The invariant the ordering exists for: never leave a publicly served
    // object that no row owns. The write happened, so it has to be undone.
    expect(written.objects).toEqual([{ key: ID, size: HTML.length }]);
    expect(written.removed).toEqual([ID]);
  });

  test("422s a document that is not standalone, leaving the plan alone", async () => {
    const { storage, plans, written } = fakes();
    const html =
      '<!doctype html><html><body><script src="https://cdn.example.com/x.js"></script></body></html>';
    const response = await replacePlan(
      storage,
      plans,
      logger,
      put(html),
      ID,
      OWNER,
      CONFIG,
    );

    expect(response.status).toBe(422);
    expect(written).toEqual({ objects: [], sizes: [], removed: [] });
  });

  test("502s when the object write fails, leaving the row untouched", async () => {
    const { storage, plans, written } = fakes({ storageFails: true });
    const response = await replacePlan(
      storage,
      plans,
      logger,
      put(),
      ID,
      OWNER,
      CONFIG,
    );

    expect(response.status).toBe(502);
    // Nothing was written, so nothing has to be undone: the plan still serves
    // its previous document at its previous recorded size.
    expect(written).toEqual({ objects: [], sizes: [], removed: [] });
  });
});
