import { describe, expect, test } from "bun:test";
import { ErrorBody } from "../src/api/schemas.ts";
import { readUploadBody } from "../src/http/upload-body.ts";

/** Mirrors the production `MAX_UPLOAD_BYTES` default. */
const MAX = 2 * 1024 * 1024;

const HEAD = "<!doctype html><html><head><title>t</title></head><body>";
const TAIL = "</body></html>";

/**
 * A valid standalone document one byte past `limit`, so a rejection can only be
 * the size check and never validation. ASCII throughout: length is byte count.
 */
function oversized(limit: number): string {
  return HEAD + "p".repeat(limit + 1 - HEAD.length - TAIL.length) + TAIL;
}

function htmlRequest(body: string, contentLength?: number): Request {
  return new Request("https://example.test/api/plans", {
    method: "PUT",
    headers: {
      "content-type": "text/html",
      // Bun's Request does not synthesise this, so the pre-read check only
      // fires when a test declares it - as a real HTTP client would.
      ...(contentLength === undefined
        ? {}
        : { "content-length": String(contentLength) }),
    },
    body,
  });
}

describe("readUploadBody", () => {
  test("413s on a declared length over the limit, without reading the body", async () => {
    const body = oversized(MAX);
    const request = htmlRequest(body, body.length);
    const response = await readUploadBody(request, MAX);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  test("413s on an oversized body that declares no length", async () => {
    const response = await readUploadBody(htmlRequest(oversized(MAX)), MAX);
    expect((response as Response).status).toBe(413);
  });

  test("accepts a document at exactly the limit", async () => {
    const body = oversized(MAX - 1);
    expect(body.length).toBe(MAX);
    expect(await readUploadBody(htmlRequest(body), MAX)).toBeInstanceOf(
      Uint8Array,
    );
  });

  test("415s on a non-HTML content type", async () => {
    const request = new Request("https://example.test/api/plans", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await readUploadBody(request, MAX)) as Response).toHaveProperty(
      "status",
      415,
    );
  });

  test("422s on a document that is not standalone", async () => {
    const html = `${HEAD}<script src="https://cdn.example.com/x.js"></script>${TAIL}`;
    const response = (await readUploadBody(htmlRequest(html), MAX)) as Response;
    expect(response.status).toBe(422);
  });

  /**
   * The wire shape, not just the status, and parsed with the schema the
   * published document is built from - so a body that drifts from `Error` fails
   * here rather than shipping a document that lies. `error` alone for one fault
   * keeps a client that reads only that field seeing what it always saw.
   */
  const refusalBody = async (html: string) => {
    const response = (await readUploadBody(htmlRequest(html), MAX)) as Response;
    expect(response.status).toBe(422);
    return ErrorBody.parse(await response.json());
  };

  test("reports one fault as `error` with no list beside it", async () => {
    expect(await refusalBody(`${HEAD}<img src="/logo.png">${TAIL}`)).toEqual({
      error: "external reference: img[src] /logo.png",
    });
  });

  test("reports several faults as `error` plus the whole list", async () => {
    expect(
      await refusalBody(`${HEAD}<img src="/a.png"><img src="/b.png">${TAIL}`),
    ).toEqual({
      error: "external reference: img[src] /a.png",
      errors: [
        "external reference: img[src] /a.png",
        "external reference: img[src] /b.png",
      ],
    });
  });

  test("marks a capped list so the cap is not mistaken for the whole", async () => {
    const images = Array.from(
      { length: 40 },
      (_, n) => `<img src="/i${n}.png">`,
    ).join("");
    const body = await refusalBody(`${HEAD}${images}${TAIL}`);
    expect(body.errors).toHaveLength(10);
    expect(body.truncated).toBe(true);
    expect(body.errors?.[0]).toBe(body.error);
  });

  /** Exactly at the cap, nothing was dropped, so the wire must not say it was. */
  test("sends ten faults with no truncation marker", async () => {
    const images = Array.from(
      { length: 10 },
      (_, n) => `<img src="/i${n}.png">`,
    ).join("");
    const body = await refusalBody(`${HEAD}${images}${TAIL}`);
    expect(body.errors).toHaveLength(10);
    expect(body.truncated).toBeUndefined();
    expect(body.errors?.[9]).toBe("external reference: img[src] /i9.png");
  });

  /**
   * The refusal is where a caller decides what to do about a webfont, and
   * without the size the decision has been to drop the fonts and fall back to
   * system faces. The document is the one that provoked that: Google's two
   * preconnects and the stylesheet they warm up.
   */
  test("prices embedding on the wire, where fonts get abandoned", async () => {
    const body = await refusalBody(
      `${HEAD}<link rel="preconnect" href="https://fonts.gstatic.com/">` +
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">` +
        TAIL,
    );
    expect(body.errors).toEqual([
      "external reference: link[href] https://fonts.gstatic.com/ - embed fonts as data: URIs in @font-face (a latin subset costs about 65 KB)",
      "external reference: link[href] https://fonts.googleapis.com/css2?family=Inter - inline the stylesheet; embed fonts as data: URIs in @font-face (a latin subset costs about 65 KB)",
    ]);
  });
});
