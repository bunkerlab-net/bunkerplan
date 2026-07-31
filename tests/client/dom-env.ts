import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * The origin every client suite runs at. Exported so a test asserting on a
 * built URL names the same constant the environment was registered with,
 * rather than a second copy of it that can drift.
 */
export const ORIGIN = "https://plans.test";

/**
 * Installs a browser environment on the test process.
 *
 * Imported for its side effect, and imported *first* by every client suite:
 * ESM evaluates a module's dependencies in source order, so listing this above
 * the component imports is what guarantees `window`, `document`, and the
 * `HTMLElement` constructors exist before `hono/jsx/dom` and the panels are
 * evaluated.
 *
 * Registration is not done from `bunfig.toml`'s preload because the server
 * suites must keep running without a DOM: `authClient()` refuses to construct
 * outside a browser by checking `typeof window`, and a globally installed
 * `window` would make that branch unreachable.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: `${ORIGIN}/` });
}
