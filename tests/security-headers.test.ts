import { describe, expect, test } from "bun:test";
import {
  applySecurityHeaders,
  PLAN_CSP,
  PLAN_DOCUMENT_HEADER,
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
  const marked = (init: ResponseInit = {}) => {
    // Through `Headers`, not an object spread: `init.headers` may be a
    // `Headers` or an array of pairs, and spreading either of those yields an
    // object with none of the entries in it - the marker would survive and the
    // caller's headers would vanish.
    const headers = new Headers(init.headers);
    headers.set(PLAN_DOCUMENT_HEADER, "1");
    return harden("https://plan.example/p/abcd1234", { ...init, headers });
  };

  /**
   * The regression that matters. A response `servePlan` marked as a plan
   * document must not reach a client without the sandbox policy, and must not
   * inherit the app policy - which has no `sandbox` and so reads as
   * permission to script the real origin. Both failures were reachable: the
   * `304` branch used to send almost no headers, and a wrapper that merely
   * skipped the backfill would have sent none at all.
   */
  test.each([200, 304])(
    "pins the plan policy onto a marked %i that omits it",
    (status) => {
      const response = marked({ status });
      expect(get(response, "content-security-policy")).toBe(PLAN_CSP);
    },
  );

  test.each([200, 304])(
    "overrides a wrong policy a marked %i already carries",
    (status) => {
      const response = marked({
        status,
        headers: { "content-security-policy": "default-src *" },
      });
      expect(get(response, "content-security-policy")).toBe(PLAN_CSP);
    },
  );

  /**
   * Both branches, because they are different code: the `304` path used to
   * send almost no headers, and a marker that survived it would leak an
   * internal name to the client on exactly the responses nobody inspects.
   */
  test.each([200, 304])(
    "strips the marker off a %i so it never leaves the process",
    (status) => {
      expect(get(marked({ status }), PLAN_DOCUMENT_HEADER)).toBeNull();
    },
  );

  test("the pinned policy sandboxes and blocks fetching", () => {
    const csp = get(marked({ status: 200 }), "content-security-policy");
    expect(csp).toContain("sandbox");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });

  /**
   * The app's own pages on the plan path - the 404 for an unknown id, the
   * gate at 401 - never set the marker, and sandboxing them would break
   * hydration. The path and status say nothing; only the marker selects.
   */
  test.each([200, 401, 404])(
    "leaves an unmarked %i on the plan path under the app policy",
    (status) => {
      const response = harden("https://plan.example/p/abcd1234", { status });
      expect(get(response, "content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(get(response, "content-security-policy")).not.toContain("sandbox");
    },
  );
});
