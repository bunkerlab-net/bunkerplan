import { describe, expect, test } from "bun:test";
import {
  applySecurityHeaders,
  PLAN_CSP,
} from "../src/http/security-headers.ts";

const get = (response: Response, name: string) => response.headers.get(name);

function harden(
  url: string,
  init: ResponseInit & { body?: string } = {},
): Response {
  const { body, ...rest } = init;
  return applySecurityHeaders(
    new Request(url),
    new Response(body ?? null, rest),
  );
}

describe("applySecurityHeaders - app routes", () => {
  test("adds the app policy and the framing controls", () => {
    const response = harden("https://plan.example/dashboard");
    expect(get(response, "content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(get(response, "x-frame-options")).toBe("DENY");
    expect(get(response, "x-content-type-options")).toBe("nosniff");
    expect(get(response, "referrer-policy")).toBe("no-referrer");
  });

  test("does not override a header a route set deliberately", () => {
    const response = harden("https://plan.example/dashboard", {
      headers: { "referrer-policy": "origin" },
    });
    expect(get(response, "referrer-policy")).toBe("origin");
  });

  test("sends HSTS over TLS only", () => {
    expect(
      get(harden("https://plan.example/"), "strict-transport-security"),
    ).toContain("max-age=");
    expect(
      get(harden("http://localhost:3000/"), "strict-transport-security"),
    ).toBeNull();
  });

  test("preserves status and body", async () => {
    const response = harden("https://plan.example/x", {
      status: 418,
      body: "teapot",
    });
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("teapot");
  });
});

describe("applySecurityHeaders - plan responses", () => {
  /**
   * The regression that matters. A plan response that omits the policy must
   * not reach a client without it, and must not inherit the app policy - which
   * has no `sandbox` and so reads as permission to script the real origin.
   * Both failures were reachable: the `304` branch used to send almost no
   * headers, and a wrapper that merely skipped the backfill would have sent
   * none at all.
   */
  test.each([200, 304])(
    "pins the plan policy onto a %i that omits it",
    (status) => {
      const response = harden("https://plan.example/p/AbCd1234", { status });
      expect(get(response, "content-security-policy")).toBe(PLAN_CSP);
    },
  );

  test.each([200, 304])(
    "overrides a wrong policy a %i already carries",
    (status) => {
      const response = harden("https://plan.example/p/AbCd1234", {
        status,
        headers: { "content-security-policy": "default-src *" },
      });
      expect(get(response, "content-security-policy")).toBe(PLAN_CSP);
    },
  );

  test("the pinned policy sandboxes and blocks fetching", () => {
    const csp = get(
      harden("https://plan.example/p/AbCd1234", { status: 200 }),
      "content-security-policy",
    );
    expect(csp).toContain("sandbox");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });

  /**
   * `/p/{unknown}` falls through to the app's own 404 page. That is trusted
   * HTML and needs the app policy - sandboxing it would break hydration.
   */
  test("leaves the app 404 under the app policy", () => {
    const response = harden("https://plan.example/p/AbCd1234", { status: 404 });
    expect(get(response, "content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(get(response, "content-security-policy")).not.toContain("sandbox");
  });

  test("does not sandbox a path that merely starts with p", () => {
    const response = harden("https://plan.example/plans", { status: 200 });
    expect(get(response, "content-security-policy")).not.toContain("sandbox");
  });
});
