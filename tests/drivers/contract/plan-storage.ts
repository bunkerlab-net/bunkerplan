import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newPlanId } from "../../../src/ids.ts";
import type { PlanObject, PlanStorage } from "../../../src/services/types.ts";
import { FIXTURE_TIMEOUT_MS, type StorageFixture } from "../backends.ts";

/**
 * The `PlanStorage` contract, run against every implementation of it.
 *
 * R2 and S3 are different protocols with different consistency stories and
 * different error shapes, and `/p/{planId}` reaches both through one
 * interface. A divergence between them is a bug on one deployment and not the
 * other - the worst kind to find in production - so both are held to the same
 * assertions here rather than to a suite each.
 *
 * Every `get` below goes through `read` or `text`. Both stores hand back a
 * live body, and an abandoned one holds its connection: leaving even one
 * unread eventually stalls the next request instead of failing an assertion.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function collect(object: PlanObject): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = object.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export function describePlanStorage(
  name: string,
  open: () => Promise<StorageFixture>,
  options: { skip: boolean },
): void {
  describe.skipIf(options.skip)(`PlanStorage: ${name}`, () => {
    let fixture: StorageFixture;
    let storage: PlanStorage;
    let n = 0;

    /**
     * Distinct per call, so tests sharing one store cannot collide, and
     * alphanumeric because the drivers refuse anything else - see the
     * namespacing block.
     */
    const nextId = () => {
      n += 1;
      return `${fixture.unique}${n}`;
    };

    const put = (id: string, body: string) =>
      storage.put(id, encoder.encode(body));

    /** The whole object, body drained. Null for a miss. */
    async function read(
      id: string,
    ): Promise<{ bytes: Uint8Array; size: number; etag: string } | null> {
      const object = await storage.get(id);
      if (object === null) return null;
      return {
        bytes: await collect(object),
        size: object.size,
        etag: object.etag,
      };
    }

    const text = async (id: string) => {
      const object = await read(id);
      return object === null ? null : decoder.decode(object.bytes);
    };

    beforeAll(async () => {
      fixture = await open();
      storage = fixture.subject;
    }, FIXTURE_TIMEOUT_MS);

    afterAll(async () => {
      await fixture.close();
    }, FIXTURE_TIMEOUT_MS);

    describe("round trip", () => {
      test("get returns the body, its size, and an etag", async () => {
        const id = nextId();
        const body = "<!doctype html><html><body>hi</body></html>";
        await put(id, body);

        const object = await read(id);
        expect(object).not.toBeNull();
        expect(object?.size).toBe(body.length);
        // The etag is served as a validator, so it has to be non-empty and
        // stable - a blank one turns every conditional request into a 200.
        expect(object?.etag).toBeTruthy();
        expect(decoder.decode(object?.bytes)).toBe(body);

        expect((await read(id))?.etag).toBe(object?.etag ?? "");
      });

      test("overwrite replaces the body, the size, and the etag", async () => {
        const id = nextId();
        await put(id, "first");
        const before = await read(id);

        const revised = "second, which is longer";
        await put(id, revised);
        const after = await read(id);

        expect(decoder.decode(after?.bytes)).toBe(revised);
        expect(after?.size).toBe(revised.length);
        expect(after?.etag).not.toBe(before?.etag);
      });

      test("delete removes it and a later get misses", async () => {
        const id = nextId();
        await put(id, "temporary");
        expect(await text(id)).toBe("temporary");

        await storage.delete(id);
        expect(await storage.get(id)).toBeNull();
      });

      test("get misses for an id that was never written", async () => {
        expect(await storage.get(nextId())).toBeNull();
      });

      test("delete is idempotent, so a retried cleanup still succeeds", async () => {
        const id = nextId();
        await put(id, "once");
        await storage.delete(id);
        // The delete path retries after a partial failure; a second delete
        // throwing would turn a recoverable state into a stuck one.
        await storage.delete(id);
        await storage.delete(nextId());
        expect(await storage.get(id)).toBeNull();
      });

      test("probe resolves against a reachable store", async () => {
        // `/healthz` reports on this, so it must resolve rather than throw
        // when the bucket exists but holds no such key.
        await storage.probe();
      });
    });

    describe("namespacing", () => {
      test("writes under plans/ and nothing at the bare id", async () => {
        const id = nextId();
        await put(id, "namespaced");

        expect(await fixture.raw.get(`plans/${id}`)).toBe("namespaced");
        expect(await fixture.raw.get(id)).toBeNull();
      });

      /**
       * The prefix on its own is not containment, and it means different
       * things to the two stores: R2 keys are opaque bytes, while an S3 key
       * becomes a URL path whose dot segments the HTTP layer collapses - so
       * `../x` leaves the bucket and `./x` aliases the plan whose id is `x`.
       * `src/storage/object-key.ts` refuses the shape instead, which is what
       * makes both stores answer these identically.
       *
       * Every call site already checks `isPlanId`; this is the second line,
       * and it is the one that matters if a future one forgets the first.
       */
      test.each([
        ["parent traversal", "../DECOY"],
        ["deep traversal", "../../../DECOY"],
        ["absolute path", "/DECOY"],
        ["nested path", "backups/DECOY"],
        ["dot segment", "./DECOY"],
        ["trailing dot segment", "DECOY/.."],
        ["prefix restated", "plans/DECOY"],
        ["empty", ""],
        ["bare dot", "."],
        ["percent-encoded slash", "..%2FDECOY"],
        ["backslash", "..\\DECOY"],
        ["newline", "DECOY\nx"],
        ["nul byte", "DECOY\u0000"],
        ["unicode", "pl\u00e4n"],
      ])("refuses a %s id outright", async (_, shape) => {
        const decoy = `decoy${nextId()}`;
        await fixture.raw.put(decoy, "NOT-A-PLAN");
        const hostile = shape.replace("DECOY", decoy);

        await expect(storage.get(hostile)).rejects.toThrow(/non-plan id/);
        await expect(put(hostile, "OVERWRITTEN")).rejects.toThrow(
          /non-plan id/,
        );
        await expect(storage.delete(hostile)).rejects.toThrow(/non-plan id/);

        // Nothing reached the store, so the decoy is byte-identical and no
        // key was created outside the namespace.
        expect(await fixture.raw.get(decoy)).toBe("NOT-A-PLAN");
        for (const key of await fixture.raw.keys()) {
          if (key.startsWith("decoy")) continue;
          expect(key.startsWith("plans/")).toBe(true);
        }
      });

      test("still accepts every id the generator can issue", async () => {
        // The refusal above is only safe because it cannot refuse a real id.
        for (const id of ["a", "z9", newPlanId(8), newPlanId(63)]) {
          await put(id, `body-${id}`);
          expect(await text(id)).toBe(`body-${id}`);
        }
      });
    });

    describe("payloads", () => {
      test("an empty document round-trips as zero bytes, not a miss", async () => {
        const id = nextId();
        await storage.put(id, new Uint8Array());

        const object = await read(id);
        expect(object).not.toBeNull();
        expect(object?.size).toBe(0);
        expect(object?.bytes.byteLength).toBe(0);
      });

      test("bytes survive unchanged, including NUL and invalid UTF-8", async () => {
        const id = nextId();
        // A store that decodes and re-encodes, or that treats NUL as a
        // terminator, corrupts this and nothing else would notice.
        const body = new Uint8Array([
          0x3c, 0x21, 0x00, 0xed, 0xa0, 0x80, 0xff, 0xfe, 0x0a, 0x3e,
        ]);
        await storage.put(id, body);

        const object = await read(id);
        expect(object?.size).toBe(body.byteLength);
        expect([...(object?.bytes ?? [])]).toEqual([...body]);
      });

      test("a document at the upload ceiling round-trips byte for byte", async () => {
        const id = nextId();
        // The default MAX_UPLOAD_BYTES, so this is the largest object the
        // application will ever hand a driver.
        const body = new Uint8Array(2_097_152);
        crypto.getRandomValues(body.subarray(0, 65_536));
        body[body.length - 1] = 0x7a;
        await storage.put(id, body);

        const object = await read(id);
        expect(object?.size).toBe(body.byteLength);
        expect(object?.bytes.byteLength).toBe(body.byteLength);
        expect(Bun.SHA256.hash(object?.bytes ?? new Uint8Array(), "hex")).toBe(
          Bun.SHA256.hash(body, "hex"),
        );
      });
    });

    describe("concurrency", () => {
      test("racing writes to one id settle on one whole body, never a mix", async () => {
        const id = nextId();
        const bodies = Array.from({ length: 8 }, (_, i) => `${i}`.repeat(4096));
        await Promise.all(bodies.map((body) => put(id, body)));

        // Last write wins on both stores; which one wins is not the contract.
        // That a reader never sees a torn object is.
        const settled = await text(id);
        expect(settled).not.toBeNull();
        expect(bodies).toContain(settled ?? "");
      });

      test("a delete racing a write leaves no half-object", async () => {
        const id = nextId();
        await put(id, "original");

        await Promise.all([put(id, "replacement"), storage.delete(id)]);

        const settled = await text(id);
        expect(settled === null || settled === "replacement").toBe(true);
      });

      test("distinct ids written together stay distinct", async () => {
        const ids = Array.from({ length: 16 }, () => nextId());
        await Promise.all(ids.map((id) => put(id, `body-${id}`)));

        expect(await Promise.all(ids.map((id) => text(id)))).toEqual(
          ids.map((id) => `body-${id}`),
        );
      });
    });
  });
}
