import type { PlanObject, PlanStorage } from "../services/types.ts";

// R2Bucket / R2ObjectBody are ambient globals from the generated
// worker-configuration.d.ts - see `bun run cf-typegen`.

const CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * Plans own the `plans/` namespace and address nothing outside it. The bucket
 * is not assumed to be exclusively ours - a self-hosted deployment may point
 * at one that already holds other things - and `/p/{planId}` builds a key
 * from a URL path segment. Ids become keys here rather than at the call
 * sites, so there is one place that knows the layout.
 */
const KEY_PREFIX = "plans/";

const objectKey = (id: string) => `${KEY_PREFIX}${id}`;

export function createR2Storage(bucket: R2Bucket): PlanStorage {
  return {
    async put(id, body) {
      await bucket.put(objectKey(id), body, {
        httpMetadata: { contentType: CONTENT_TYPE },
      });
    },

    async get(id): Promise<PlanObject | null> {
      const object = await bucket.get(objectKey(id));
      // The overload returns R2Object (no body) for conditional gets. We make
      // an unconditional one, so a bodyless result means the object is not
      // retrievable - treat it as a miss rather than serving an empty page.
      if (object === null || !("body" in object)) return null;
      return { body: object.body, size: object.size, etag: object.httpEtag };
    },

    async delete(id) {
      await bucket.delete(objectKey(id));
    },

    // The binding has no HEAD-bucket operation. A `null` return still proves a
    // successful round-trip, so only a thrown error counts as failure.
    async probe() {
      await bucket.head("__healthz__");
    },
  };
}
