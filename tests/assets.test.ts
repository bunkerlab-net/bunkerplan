import { describe, expect, test } from "bun:test";
import { isAssetManifest, MANIFEST_FILENAME } from "../src/server/assets.ts";
import { ASSETS } from "../src/server/manifest.generated.ts";

const ROOT = `${import.meta.dir}/..`;
const CLIENT = `${ROOT}/dist/client`;

/**
 * Vite used to inject the hashed script and stylesheet into the document, so
 * the page could not reference a file the build had not emitted.
 * `scripts/build.ts` writes them into a module instead, which means nothing
 * checks that the two agree - except this.
 *
 * A mismatch serves a dead `<script>`: the page renders unstyled and never
 * hydrates, with no error anywhere.
 */
describe("the generated asset manifest", () => {
  test("names files the build actually emitted", async () => {
    expect(await Bun.file(`${CLIENT}${ASSETS.script}`).exists()).toBe(true);
    expect(await Bun.file(`${CLIENT}${ASSETS.stylesheet}`).exists()).toBe(true);
  });

  test("agrees with the copy written beside the bundle", async () => {
    const onDisk: unknown = await Bun.file(
      `${CLIENT}/${MANIFEST_FILENAME}`,
    ).json();

    expect(isAssetManifest(onDisk)).toBe(true);
    expect(onDisk).toEqual({ ...ASSETS });
  });

  test("serves both from the root, content-hashed", () => {
    for (const path of [ASSETS.script, ASSETS.stylesheet]) {
      expect(path).toStartWith("/");
      // `entry-<hash>.<ext>` - without the hash a replaced bundle would be
      // served from cache under the same name.
      expect(path).toMatch(/^\/entry-[a-z0-9]+\.(js|css)$/);
    }
  });

  /**
   * `public/` is copied by hand now that Vite's publicDir is gone, so a file
   * that quietly stopped being copied would only surface as a 404 in a
   * browser. These four are the ones the rendered document references.
   */
  test("carries everything the document links to", async () => {
    for (const file of [
      "favicon.svg",
      "favicon-32.png",
      "apple-touch-icon.png",
      "og-v2.png",
      "scalar/standalone.js",
    ]) {
      expect(await Bun.file(`${CLIENT}/${file}`).exists()).toBe(true);
    }
  });
});
