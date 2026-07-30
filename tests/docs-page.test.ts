import { describe, expect, test } from "bun:test";
import {
  DOCS_BOOT_PATH,
  DOCS_PAGE,
  SCALAR_SCRIPT_PATH,
} from "../src/api/docs-page.ts";

const PUBLIC = `${import.meta.dir}/../public`;
const VENDORED = `${PUBLIC}${SCALAR_SCRIPT_PATH}`;
const BOOT = `${PUBLIC}${DOCS_BOOT_PATH}`;

describe("the /api/docs page", () => {
  /**
   * The bug this exists for: the bootstrap used to be an inline `<script>`, and
   * `script-src 'self'` refuses those. The page served, the reference never
   * mounted, and every server-side assertion still passed - a document is only
   * visibly broken once something executes it.
   */
  test("carries no inline script, which the app policy would refuse", () => {
    const scripts = DOCS_PAGE.match(/<script\b[^>]*>/g) ?? [];

    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toContain(" src=");
    }
  });

  /**
   * The app loads nothing off-origin, and the reference must not be the
   * exception. Scalar's defaults break that twice: the theme fetches fonts
   * from fonts.scalar.com, and the AI chat fetches the document registry from
   * api.scalar.com before anyone has asked it for anything.
   *
   * A source check, deliberately. Observing it instead means booting a server,
   * a browser and a 3.5 MB bundle to watch what it requests - and the thing
   * that would break here is a config flag flipping back, which is exactly
   * what reading the config catches. The runtime half is covered where it can
   * be cheap: tests/app-routes.test.ts pins the `script-src 'self'` policy
   * that refuses an off-origin script whatever the page asks for.
   */
  test("loads the spec by URL and reaches nothing off-origin", async () => {
    const boot = await Bun.file(BOOT).text();
    // Whitespace-normalised, so re-indenting the file or wrapping a line does
    // not read as the setting having changed.
    const code = boot
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ");

    expect(code).toContain('url: "/api/openapi.json"');
    expect(code).toContain("withDefaultFonts: false");
    expect(code).toContain("agent: { disabled: true }");
    // Both comment forms are stripped above, so the hosts those comments name
    // do not answer for the code.
    expect(code).not.toContain("scalar.com");
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
   * And so is the bootstrap, which is committed rather than vendored.
   *
   * Three things have to agree: the page asks for a path, that path exists in
   * `public/`, and the build copies it to where the server serves from.
   * Existence in the source tree alone would pass for a document that dropped
   * the tag, and for a build that stopped copying `public/` - both of which
   * ship the same dead page the inline `<script>` did.
   */
  test("the bootstrap is asked for, committed, and built", async () => {
    const srcs = [...DOCS_PAGE.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(srcs).toEqual([SCALAR_SCRIPT_PATH, DOCS_BOOT_PATH]);
    expect(await Bun.file(BOOT).exists()).toBe(true);
    // Same dependency on a build as tests/assets.test.ts, which `bun run test`
    // satisfies by building first.
    expect(
      await Bun.file(
        `${import.meta.dir}/../dist/client${DOCS_BOOT_PATH}`,
      ).exists(),
    ).toBe(true);
  });

  /**
   * The page calls exactly one function on exactly one global. `standalone.js`
   * is an IIFE with no module surface, so nothing else would catch Scalar
   * renaming or restructuring its entry point.
   */
  test("the vendored bundle defines the global the page calls", async () => {
    const bundle = await Bun.file(VENDORED).text();
    const boot = await Bun.file(BOOT).text();

    expect(bundle).toContain("window.Scalar={createApiReference:");
    expect(boot).toContain('Scalar.createApiReference("#app"');
  });
});
