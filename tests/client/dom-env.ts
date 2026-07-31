import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Installs a browser environment on the test process.
 *
 * Imported for its side effect, and imported *first* by every client suite:
 * ESM evaluates a module's dependencies in source order, so listing this above
 * the component imports is what guarantees `window`, `document`, and the
 * `HTMLElement` constructors exist before `hono/jsx/dom` and the panels are
 * evaluated.
 *
 * Nothing is exported on purpose. A named import from here sorts in with the
 * others - Biome moved one below `PlansPanel` once - and the bare form is what
 * keeps the side effect first. A suite that needs the origin reads
 * `window.location.origin`, which is this value by definition.
 *
 * Registration is not done from `bunfig.toml`'s preload because the server
 * suites must keep running without a DOM: `authClient()` refuses to construct
 * outside a browser by checking `typeof window`, and a globally installed
 * `window` would make that branch unreachable.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "https://plans.test/" });
}
