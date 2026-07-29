import { expect, test } from "bun:test";
import { authClient } from "../../src/client/auth.ts";

/**
 * The browser-only guard, exercised with no browser.
 *
 * `authClient()` refuses outside one because it reads
 * `window.location.origin`, and WebAuthn rejects a ceremony whose origin does
 * not match. The server render imports this module - `pages.tsx` pulls in
 * `Chrome.tsx` - so the guard is what turns a component that accidentally
 * calls it during SSR into a loud failure rather than a client silently bound
 * to the wrong origin.
 *
 * `window` is removed for the duration rather than assumed absent. This file
 * does not import `./dom-env.ts`, but `@happy-dom/global-registrator` installs
 * `window` on the process and never takes it off - so under a plain
 * `bun test`, where every file shares one global, any client suite that ran
 * earlier has already put one there. Deleting it here is what makes the test
 * mean the same thing whichever runner is used.
 *
 * The memoised client is not a hazard here: `authClient()` checks `window`
 * before it touches the cached instance, so a suite that constructed one
 * earlier still gets the throw. The only thing this test needs is the absence
 * of `window`, which the body arranges rather than assumes.
 */
test("authClient refuses to construct outside a browser", () => {
  const installed = Object.getOwnPropertyDescriptor(globalThis, "window");
  Reflect.deleteProperty(globalThis, "window");

  try {
    expect(typeof globalThis.window).toBe("undefined");
    expect(() => authClient()).toThrow("authClient() is browser-only");
  } finally {
    if (installed !== undefined) {
      Object.defineProperty(globalThis, "window", installed);
    }
  }
});
