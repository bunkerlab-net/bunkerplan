import { isPlanId } from "../ids.ts";

/**
 * Plans own the `plans/` namespace and address nothing outside it. The bucket
 * is not assumed to be exclusively ours - a self-hosted deployment may point
 * at one that already holds other things - and `/p/{planId}` builds a key from
 * a URL path segment the router has already percent-decoded. Ids become keys
 * here rather than at the call sites, so there is one place, shared by both
 * drivers, that knows the layout.
 */
const KEY_PREFIX = "plans/";

/**
 * The prefix alone is not containment, and it means different things to the
 * two stores. R2 treats a key as opaque bytes, so `plans/../secret` addresses
 * a key with that literal name and finds nothing. The S3 SDK builds a URL from
 * the key, and the HTTP layer collapses dot segments in a path: `../secret`
 * escapes the bucket outright (MinIO answers `SignatureDoesNotMatch`, because
 * SigV4 signed the path before it was rewritten), and `./x` quietly resolves
 * onto the object belonging to the plan whose id is `x`.
 *
 * So the shape is refused rather than prefixed. `isPlanId` is the generator's
 * own alphabet, which is what stops this drifting from the ids that exist.
 * Every call site already checks it, and this throwing means a future one that
 * forgets fails loudly instead of reading somebody else's object.
 */
export function planObjectKey(id: string): string {
  if (!isPlanId(id)) {
    throw new Error(`refusing to address a non-plan id: ${JSON.stringify(id)}`);
  }
  return `${KEY_PREFIX}${id}`;
}
