import type { PlanObject, PlanStorage } from "../services/types.ts";
import { planObjectKey } from "./object-key.ts";

// R2Bucket / R2ObjectBody are ambient globals from the generated
// worker-configuration.d.ts - see `bun run cf-typegen`.

const CONTENT_TYPE = "text/html; charset=utf-8";

// The `plans/` mapping and the id shapes it refuses live in
// ./object-key.ts, shared with the S3 driver.

export function createR2Storage(bucket: R2Bucket): PlanStorage {
  return {
    async put(id, body) {
      await bucket.put(planObjectKey(id), body, {
        httpMetadata: { contentType: CONTENT_TYPE },
      });
    },

    async get(id): Promise<PlanObject | null> {
      const object = await bucket.get(planObjectKey(id));
      // The overload returns R2Object (no body) for conditional gets. We make
      // an unconditional one, so a bodyless result means the object is not
      // retrievable - treat it as a miss rather than serving an empty page.
      if (object === null || !("body" in object)) return null;
      return { body: object.body, size: object.size, etag: object.httpEtag };
    },

    async delete(id) {
      await bucket.delete(planObjectKey(id));
    },

    // The binding has no HEAD-bucket operation. A `null` return still proves a
    // successful round-trip, so only a thrown error counts as failure.
    async probe() {
      await bucket.head("__healthz__");
    },
  };
}
