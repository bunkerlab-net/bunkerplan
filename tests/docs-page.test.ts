import { describe, expect, test } from "bun:test";
import { DOCS_PAGE, SCALAR_SCRIPT_PATH } from "../src/api/docs-page.ts";

const VENDORED = `${import.meta.dir}/../public${SCALAR_SCRIPT_PATH}`;

describe("the /api/docs page", () => {
  /**
   * The app loads nothing off-origin, and the reference must not be the
   * exception. Scalar's defaults break that twice: the theme fetches fonts
   * from fonts.scalar.com, and the AI chat fetches the document registry from
   * api.scalar.com before anyone has asked it for anything.
   */
  test("loads the spec by URL and reaches nothing off-origin", () => {
    expect(DOCS_PAGE).toContain('"url":"/api/openapi.json"');
    expect(DOCS_PAGE).toContain('"withDefaultFonts":false');
    expect(DOCS_PAGE).toContain('"agent":{"disabled":true}');
    expect(DOCS_PAGE).not.toContain("scalar.com");
  });

  /**
   * The two ends of the same path. `scripts/vendor-scalar.ts` cannot import
   * this constant - the Docker `deps` stage runs it before `src/` is copied -
   * so this is what stops the copy and the `<script>` drifting apart.
   */
  test("loads the bundle from where postinstall puts it", async () => {
    const script = await Bun.file(
      `${import.meta.dir}/../scripts/vendor-scalar.ts`,
    ).text();

    expect(script).toContain(`"public${SCALAR_SCRIPT_PATH}"`);
    expect(DOCS_PAGE).toContain(
      `<script src="${SCALAR_SCRIPT_PATH}"></script>`,
    );
  });

  /**
   * `scripts/vendor-scalar.ts` copies this out of the devDependency, so a
   * checkout that skipped `bun install` - or one where Scalar moved the file -
   * fails here rather than serving a page with a dead `<script>`.
   */
  test("the vendored bundle is present", async () => {
    expect(await Bun.file(VENDORED).exists()).toBe(true);
  });

  /**
   * The page calls exactly one function on exactly one global. `standalone.js`
   * is an IIFE with no module surface, so nothing else would catch Scalar
   * renaming or restructuring its entry point.
   */
  test("the vendored bundle defines the global the page calls", async () => {
    const bundle = await Bun.file(VENDORED).text();
    expect(bundle).toContain("window.Scalar={createApiReference:");
    expect(DOCS_PAGE).toContain("Scalar.createApiReference('#app'");
  });
});
