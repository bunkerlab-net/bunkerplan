import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addGrants,
  clearShareCode,
  deletePlan,
  getSharing,
  listPlans,
  type PlanSummary,
  relabelPlan,
  removeGrant,
  replacePlan,
  rotateShareCode,
  setVisibility,
  unlockPlan,
  uploadPlan,
} from "../../src/client/api.ts";

/**
 * The browser's side of the wire.
 *
 * Every function here is the same three steps - call, refuse on a non-2xx,
 * parse - so the suite pins the two things that are not boilerplate: the exact
 * request each one sends, because the server routes on method and path, and
 * what a refusal turns into, because that string is what the dashboard shows a
 * person. `readError` in particular has four branches and is the reason an
 * upload rejected for six reasons reports six rather than one.
 */

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const sent: Recorded[] = [];
const realFetch = globalThis.fetch;

/** The next response, or a queue of them for the multi-call cases. */
let queued: Response[] = [];

beforeEach(() => {
  sent.length = 0;
  queued = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    // Through `Headers` rather than `Object.entries`: that yields nothing for a
    // `Headers` instance or an array of pairs, so a capture would come back
    // empty and take the assertions with it. `Headers` also lower-cases keys.
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
    });
    const next = queued.shift();
    if (next === undefined) throw new Error("no response was queued");
    return next;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // A response nobody consumed means the call under test never happened, which
  // `beforeEach` would otherwise clear away silently.
  const unused = queued.length;
  queued = [];
  expect(unused).toBe(0);
});

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

/** A refusal with no JSON body at all, which is what a proxy 502 looks like. */
const plain = (status: number, statusText: string): Response =>
  new Response("<html>gateway</html>", { status, statusText });

const only = (): Recorded => {
  const [first, ...rest] = sent;
  if (first === undefined) throw new Error("nothing was sent");
  if (rest.length > 0) throw new Error(`${sent.length} requests were sent`);
  return first;
};

describe("listPlans", () => {
  test("unwraps the envelope", async () => {
    /*
     * A whole `PlanSummary` rather than `{ id }` widened with `as never`: the
     * cast made the assertion accept any shape, so a field the client silently
     * stopped passing through would still have matched.
     */
    const summary: PlanSummary = {
      id: "abc",
      url: "https://plans.example.test/p/abc",
      label: "Q3",
      size: 12,
      createdAt: "2026-01-01T00:00:00Z",
      visibility: "private",
      hasShareCode: false,
    };
    queued = [json({ plans: [summary], truncated: false })];

    expect(await listPlans()).toEqual([summary]);
    expect(only()).toMatchObject({ url: "/api/plans", method: "GET" });
  });

  test("a 401 rejects with the server's reason", async () => {
    queued = [json({ error: "authentication required" }, 401)];
    await expect(listPlans()).rejects.toThrow("authentication required");
  });
});

describe("uploadPlan", () => {
  test("sends the bytes as text/html with the visibility in the query", async () => {
    queued = [json({ id: "abc", url: "https://plans.test/p/abc" })];
    const file = new File(["<!doctype html><p>hi</p>"], "plan.html", {
      type: "text/html",
    });

    const summary = await uploadPlan(file, "public");

    const request = only();
    expect(request.url).toBe("/api/plans?visibility=public");
    expect(request.method).toBe("PUT");
    expect(request.headers["content-type"]).toBe("text/html");
    expect(new TextDecoder().decode(request.body as ArrayBuffer)).toBe(
      "<!doctype html><p>hi</p>",
    );
    // The server answers with an id and a URL only; the rest of the row is
    // synthesised here so the new plan can be listed without a refetch.
    expect(summary).toMatchObject({
      id: "abc",
      url: "https://plans.test/p/abc",
      label: null,
      size: file.size,
      visibility: "public",
      hasShareCode: false,
    });
    expect(Number.isNaN(Date.parse(summary.createdAt))).toBe(false);
  });

  test("a rejected document reports every fault, not just the first", async () => {
    queued = [
      json(
        {
          error: "external stylesheet",
          errors: ["external stylesheet", "remote script", "inline handler"],
        },
        422,
      ),
    ];

    await expect(
      uploadPlan(new File(["x"], "a.html"), "private"),
    ).rejects.toThrow("external stylesheet\nremote script\ninline handler");
  });

  test("a truncated fault list says so rather than reading complete", async () => {
    queued = [json({ errors: ["one", "two"], truncated: true }, 422)];

    await expect(
      uploadPlan(new File(["x"], "a.html"), "private"),
    ).rejects.toThrow("one\ntwo\n...and more not listed.");
  });

  test("an empty errors array falls back to the single error field", async () => {
    queued = [json({ error: "too large", errors: [] }, 413)];

    await expect(
      uploadPlan(new File(["x"], "a.html"), "private"),
    ).rejects.toThrow("too large");
  });

  test("non-string entries in errors are dropped rather than rendered", async () => {
    queued = [json({ errors: [null, "remote script", 7] }, 422)];

    // Exact, not `toThrow`'s substring: "null\nremote script\n7" contains
    // "remote script" too, so a substring match would pass on precisely the
    // rendering this test is named for preventing.
    const failure = await uploadPlan(
      new File(["x"], "a.html"),
      "private",
    ).catch((cause: unknown) => cause);
    expect((failure as Error).message).toBe("remote script");
  });

  test("a body that is not JSON falls back to the status line", async () => {
    queued = [plain(502, "Bad Gateway")];

    await expect(
      uploadPlan(new File(["x"], "a.html"), "private"),
    ).rejects.toThrow("502 Bad Gateway");
  });

  test("a JSON body with no error field falls back to the status line", async () => {
    queued = [json({ unrelated: true }, 500)];

    await expect(
      uploadPlan(new File(["x"], "a.html"), "private"),
    ).rejects.toThrow("500");
  });

  test("a status with no reason phrase does not leave a dangling space", async () => {
    queued = [new Response("nope", { status: 418, statusText: "" })];

    await expect(
      uploadPlan(new File(["x"], "a.html"), "private"),
    ).rejects.toThrow(/^418$/);
  });

  test("a JSON null body falls back to the status line", async () => {
    queued = [json(null, 500)];

    await expect(
      uploadPlan(new File(["x"], "a.html"), "private"),
    ).rejects.toThrow("500");
  });
});

describe("relabelPlan", () => {
  test("PATCHes the label as JSON", async () => {
    queued = [json({ ok: true })];
    await relabelPlan("abc", "Q3 plan");

    expect(only()).toMatchObject({
      url: "/api/plans/abc",
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"label":"Q3 plan"}',
    });
  });

  test("clearing a label sends null, not an empty string", async () => {
    queued = [json({ ok: true })];
    await relabelPlan("abc", null);

    expect(only().body).toBe('{"label":null}');
  });

  test("a refusal rejects", async () => {
    queued = [json({ error: "label too long" }, 422)];
    await expect(relabelPlan("abc", "x")).rejects.toThrow("label too long");
  });
});

describe("deletePlan", () => {
  test("DELETEs the item", async () => {
    queued = [new Response(null, { status: 204 })];
    await deletePlan("abc");

    expect(only()).toMatchObject({ url: "/api/plans/abc", method: "DELETE" });
  });

  test("a 404 rejects", async () => {
    queued = [json({ error: "no such plan" }, 404)];
    await expect(deletePlan("abc")).rejects.toThrow("no such plan");
  });
});

describe("replacePlan", () => {
  test("PUTs the new bytes at the same id", async () => {
    queued = [json({ ok: true })];
    await replacePlan("abc", new File(["<p>new</p>"], "plan.html"));

    const request = only();
    expect(request).toMatchObject({ url: "/api/plans/abc", method: "PUT" });
    // The route refuses a body that does not declare itself as HTML, so the
    // header is part of the request rather than decoration on it.
    expect(request.headers["content-type"]).toBe("text/html");
    expect(new TextDecoder().decode(request.body as ArrayBuffer)).toBe(
      "<p>new</p>",
    );
  });

  test("a refusal rejects", async () => {
    queued = [json({ errors: ["remote script"] }, 422)];
    await expect(replacePlan("abc", new File(["x"], "a.html"))).rejects.toThrow(
      "remote script",
    );
  });
});

describe("getSharing", () => {
  test("reads the sharing state", async () => {
    queued = [
      json({ visibility: "private", hasShareCode: true, grants: ["a"] }),
    ];

    expect(await getSharing("abc")).toEqual({
      visibility: "private",
      hasShareCode: true,
      grants: ["a"],
    });
    expect(only()).toMatchObject({
      url: "/api/plans/abc/sharing",
      method: "GET",
    });
  });

  test("a refusal rejects", async () => {
    queued = [json({ error: "not yours" }, 403)];
    await expect(getSharing("abc")).rejects.toThrow("not yours");
  });
});

describe("setVisibility", () => {
  test("PUTs the new visibility and returns the settled state", async () => {
    queued = [json({ visibility: "public", hasShareCode: false, grants: [] })];

    expect(await setVisibility("abc", "public")).toMatchObject({
      visibility: "public",
    });
    expect(only()).toMatchObject({
      url: "/api/plans/abc/sharing",
      method: "PUT",
      body: '{"visibility":"public"}',
      headers: { "content-type": "application/json" },
    });
  });

  test("a refusal rejects", async () => {
    queued = [json({ error: "not yours" }, 403)];
    await expect(setVisibility("abc", "public")).rejects.toThrow("not yours");
  });
});

describe("rotateShareCode", () => {
  test("returns the plaintext code, which is only ever returned here", async () => {
    queued = [json({ code: "abcd1234efgh5678" })];

    expect(await rotateShareCode("abc")).toBe("abcd1234efgh5678");
    expect(only()).toMatchObject({
      url: "/api/plans/abc/share-code",
      method: "POST",
    });
  });

  test("a refusal rejects", async () => {
    queued = [json({ error: "not yours" }, 403)];
    await expect(rotateShareCode("abc")).rejects.toThrow("not yours");
  });
});

describe("clearShareCode", () => {
  test("DELETEs the code", async () => {
    queued = [new Response(null, { status: 204 })];
    await clearShareCode("abc");

    expect(only()).toMatchObject({
      url: "/api/plans/abc/share-code",
      method: "DELETE",
    });
  });

  test("a refusal rejects", async () => {
    queued = [json({ error: "no such plan" }, 404)];
    await expect(clearShareCode("abc")).rejects.toThrow("no such plan");
  });
});

describe("addGrants", () => {
  test("sends the list verbatim for the server to split", async () => {
    queued = [json({ granted: ["a"], unknown: ["b"], failed: [] })];

    expect(await addGrants("abc", " a , b ")).toEqual({
      granted: ["a"],
      unknown: ["b"],
      failed: [],
    });
    expect(only()).toMatchObject({
      url: "/api/plans/abc/grants",
      method: "POST",
      body: '{"accounts":" a , b "}',
      headers: { "content-type": "application/json" },
    });
  });

  test("a refusal rejects", async () => {
    queued = [json({ error: "too many accounts" }, 422)];
    await expect(addGrants("abc", "a")).rejects.toThrow("too many accounts");
  });
});

describe("removeGrant", () => {
  test("escapes the handle into the path", async () => {
    queued = [new Response(null, { status: 204 })];
    await removeGrant("abc", "odd handle/../x");

    expect(only()).toMatchObject({
      url: "/api/plans/abc/grants/odd%20handle%2F..%2Fx",
      method: "DELETE",
    });
  });

  test("a refusal rejects", async () => {
    queued = [json({ error: "no such grant" }, 404)];
    await expect(removeGrant("abc", "a")).rejects.toThrow("no such grant");
  });
});

describe("unlockPlan", () => {
  test("posts the code", async () => {
    queued = [new Response(null, { status: 204 })];
    await unlockPlan("abc", "code1234");

    expect(only()).toMatchObject({
      url: "/api/plans/abc/unlock",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"code":"code1234"}',
    });
  });

  test("a wrong code rejects with the server's reason", async () => {
    queued = [json({ error: "wrong code" }, 403)];
    await expect(unlockPlan("abc", "nope")).rejects.toThrow("wrong code");
  });

  test("a rate limit names the wait rather than the limiter", async () => {
    queued = [
      new Response(null, { status: 429, headers: { "retry-after": "42" } }),
    ];

    await expect(unlockPlan("abc", "nope")).rejects.toThrow(
      "Too many attempts. Try again in 42 seconds.",
    );
  });

  test("a rate limit with no retry-after still reads as a wait", async () => {
    queued = [new Response(null, { status: 429 })];

    await expect(unlockPlan("abc", "nope")).rejects.toThrow(
      "Too many attempts. Try again shortly.",
    );
  });

  test("a nonsense retry-after does not leak NaN into the message", async () => {
    queued = [
      new Response(null, {
        status: 429,
        headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
      }),
    ];

    await expect(unlockPlan("abc", "nope")).rejects.toThrow(
      "Too many attempts. Try again shortly.",
    );
  });

  test("a negative retry-after does not promise a wait in the past", async () => {
    queued = [
      new Response(null, { status: 429, headers: { "retry-after": "-5" } }),
    ];

    await expect(unlockPlan("abc", "nope")).rejects.toThrow(
      "Too many attempts. Try again shortly.",
    );
  });

  test("a zero retry-after reads as no wait rather than 'in 0 seconds'", async () => {
    queued = [
      new Response(null, { status: 429, headers: { "retry-after": "0" } }),
    ];

    // The boundary of the `> 0` guard: zero is finite and not negative, so a
    // `>= 0` test would send the reader back immediately and phrase it as a
    // wait that has already elapsed.
    await expect(unlockPlan("abc", "nope")).rejects.toThrow(
      "Too many attempts. Try again shortly.",
    );
  });
});
