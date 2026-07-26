/**
 * What a thrown handler sends back.
 *
 * The app registers no `onError`, so this is Hono's default answer plus the
 * header middleware. That combination is easy to assume is broken - the
 * middleware applies its headers after `await next()`, which looks like it
 * cannot run when the handler throws. It does: the throw is caught further
 * in, so `next()` resolves. These tests hold that, since the alternative is
 * shipping the one response in the app that carries no policy.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { createApp } from "../src/app.ts";

const BOOM = "config is unreadable";

/**
 * The failure this file is about: `getServices()` throwing. It is the real
 * shape of the problem - on Workers the services are built from bindings and
 * the configuration on first use, so a bad deployment throws here rather than
 * at boot, on whatever request happens to arrive first.
 */
function brokenApp() {
  return createApp({
    getServices: () => {
      throw new Error(BOOM);
    },
    runtime: "node",
    assets: { script: "/entry.js", stylesheet: "/entry.css" },
  });
}

/** Keeps the deliberate throw out of the test output. */
async function fetchQuietly(path: string): Promise<Response> {
  const silenced = spyOn(console, "error").mockImplementation(() => {});
  try {
    return await brokenApp().fetch(new Request(`http://localhost${path}`));
  } finally {
    silenced.mockRestore();
  }
}

describe("a handler that throws", () => {
  test("still answers with the security headers", async () => {
    const response = await fetchQuietly("/api/plans");

    // Hono catches a throw at the dispatch level that owns the handler, sets
    // the response from its own error handler there, and returns normally.
    // So `await next()` in the header middleware resolves and the policy is
    // applied on the way out, exactly as for a response nobody threw for.
    expect(response.status).toBe(500);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("does not put the thrown message in the body", async () => {
    const response = await fetchQuietly("/api/plans");
    const body = await response.text();

    // A throw from `loadConfig` can carry a connection string. The reply says
    // nothing beyond the status; the detail belongs in the log.
    expect(body).not.toContain(BOOM);
    expect(body).toBe("Internal Server Error");
  });

  test("applies the app policy to a throw under /p/, not the plan sandbox", async () => {
    const response = await fetchQuietly("/p/whatever");

    // `PLAN_CSP` sandboxes untrusted uploaded HTML. It is keyed on a 200, so
    // an error under the plan prefix must not inherit it - this page is ours.
    expect(response.status).toBe(500);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("content-security-policy")).not.toContain(
      "sandbox",
    );
  });
});
