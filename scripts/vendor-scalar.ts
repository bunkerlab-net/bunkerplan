/**
 * Puts Scalar's browser bundle where the build can serve it.
 *
 * `@scalar/api-reference` is a devDependency for exactly one prebuilt file.
 * That file is 3.5 MB, so it belongs in `public/` - copied into `dist/client`
 * by scripts/build.ts and served as a static asset - and not in the server
 * bundle, which on Workers is limited to 3 MB compressed. Importing the
 * package from a route instead would put the whole reference, around 1.6 MB
 * gzip, inside that limit.
 *
 * Runs on `postinstall`, so the file is there before any build, dev server, or
 * test, and tracks whatever version the lockfile resolved. The copy is
 * gitignored.
 *
 * Deliberately imports nothing: the Docker `deps` stage installs against
 * `package.json` alone, so this file has to run before `src/` exists. The
 * target below is `SCALAR_SCRIPT_PATH` from src/api/docs-page.ts, and
 * tests/docs-page.test.ts holds the two together.
 */
const SOURCE = "node_modules/@scalar/api-reference/dist/browser/standalone.js";
const TARGET = "public/scalar/standalone.js";

const source = Bun.file(SOURCE);
if (!(await source.exists())) {
  console.error(
    `${SOURCE} is missing.\n` +
      "It ships in the @scalar/api-reference devDependency; run `bun install`" +
      " without --production.",
  );
  process.exit(1);
}

await Bun.write(TARGET, source);
