/**
 * The hashed filenames `scripts/build.ts` emitted for the browser bundle.
 *
 * The build writes them twice: into `src/server/manifest.generated.ts`, which
 * the entry points import and both bundlers inline, and as
 * `dist/client/manifest.json` beside the output, so a deployment can be
 * inspected without the source tree. The server reads the first; the second
 * exists to be checked against it.
 *
 * A mismatch serves a dead `<script>` - the page renders unstyled and never
 * hydrates, with no error anywhere - so tests/assets.test.ts holds all three
 * to each other.
 */
export interface AssetManifest {
  /** Client entry, content-hashed. */
  script: string;
  /** Stylesheet extracted from that entry, content-hashed. */
  stylesheet: string;
}

export const MANIFEST_FILENAME = "manifest.json";

export function isAssetManifest(value: unknown): value is AssetManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["script"] === "string" &&
    typeof candidate["stylesheet"] === "string"
  );
}
