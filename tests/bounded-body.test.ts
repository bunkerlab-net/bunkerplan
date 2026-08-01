import { describe, expect, test } from "bun:test";
import { readBoundedBody, readJsonBody } from "../src/http/bounded-body.ts";

const LIMIT = 1024;
const encode = (text: string) => new TextEncoder().encode(text);

/**
 * A body delivered as a stream, which is what a chunked or HTTP/2 request
 * looks like: `Request` synthesises no `content-length` for one, so the
 * declared-length shortcut cannot fire and only counting while reading can
 * refuse it.
 */
function streamed(chunks: string[]): Request {
  const encoder = new TextEncoder();
  return new Request("https://example.test/", {
    method: "PUT",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    // Required by fetch when the body is a stream.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readBoundedBody", () => {
  test("returns the body when it fits", async () => {
    const body = await readBoundedBody(streamed(["hello ", "world"]), LIMIT);
    expect(body).not.toBeNull();
    expect(new TextDecoder().decode(body ?? undefined)).toBe("hello world");
  });

  test("joins many chunks in order", async () => {
    const parts = Array.from({ length: 50 }, (_, i) => `${i},`);
    const body = await readBoundedBody(streamed(parts), LIMIT);
    expect(new TextDecoder().decode(body ?? undefined)).toBe(parts.join(""));
  });

  test("accepts a body of exactly the limit", async () => {
    const body = await readBoundedBody(streamed(["x".repeat(LIMIT)]), LIMIT);
    expect(body?.byteLength).toBe(LIMIT);
  });

  /**
   * The regression. `Number("")` is `0`, so a body with no declared length
   * used to pass the pre-check and then land in memory whole before anything
   * measured it. A stream declares no length, which is exactly the shape of a
   * chunked or HTTP/2 upload.
   */
  test("refuses an oversized body that declares no length", async () => {
    expect(
      await readBoundedBody(streamed(["x".repeat(LIMIT + 1)]), LIMIT),
    ).toBeNull();
  });

  test("refuses once the running total passes the limit, mid-stream", async () => {
    const chunks = Array.from({ length: 100 }, () => "x".repeat(64));
    expect(await readBoundedBody(streamed(chunks), LIMIT)).toBeNull();
  });

  test("refuses a body whose declared length lies about being small", async () => {
    const request = new Request("https://example.test/", {
      method: "PUT",
      headers: { "content-length": "10" },
      body: "x".repeat(LIMIT + 1),
    });
    expect(await readBoundedBody(request, LIMIT)).toBeNull();
  });

  test("refuses early on an honest oversized declared length", async () => {
    const request = new Request("https://example.test/", {
      method: "PUT",
      headers: { "content-length": String(LIMIT + 1) },
      body: "x".repeat(LIMIT + 1),
    });
    expect(await readBoundedBody(request, LIMIT)).toBeNull();
    // Refused at the header, so the body was never consumed.
    expect(request.bodyUsed).toBe(false);
  });

  test("treats a missing body as empty rather than failing", async () => {
    const request = new Request("https://example.test/", { method: "DELETE" });
    expect((await readBoundedBody(request, LIMIT))?.byteLength).toBe(0);
  });
});
/** A request whose body is exactly these bytes, valid UTF-8 or not. */
function raw(bytes: Uint8Array): Request {
  return new Request("https://example.test/", {
    method: "PATCH",
    // The view's own slice of its buffer, not the whole buffer: a `subarray`
    // shares the original allocation, so `bytes.buffer` would send everything
    // around it too. Identical for a freshly built array and wrong for
    // anything derived from one.
    body: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  });
}

describe("readJsonBody", () => {
  test("parses a body that fits and is valid JSON", async () => {
    const read = await readJsonBody(raw(encode('{"label":"hi"}')), LIMIT);

    expect(read.ok).toBe(true);
    expect(read.ok && read.body).toEqual({ label: "hi" });
  });

  /**
   * The decoder is `fatal` for this case, and it is the one where being
   * lenient looks harmless. A lone `0xff` is not UTF-8; replaced with U+FFFD
   * it sits quietly inside the string, the parse succeeds, and a label nobody
   * typed is stored. Refusing is the only answer that does not invent data.
   */
  test("refuses a JSON-shaped body carrying invalid UTF-8", async () => {
    const malformed = new Uint8Array([
      ...encode('{"label":"'),
      0xff,
      ...encode('"}'),
    ]);

    const read = await readJsonBody(raw(malformed), LIMIT);

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.response.status).toBe(400);
    expect(await read.response.json()).toMatchObject({
      error: "body must be JSON",
    });
  });

  test("refuses a body that is not JSON at all", async () => {
    const read = await readJsonBody(raw(encode("not json")), LIMIT);

    expect(read.ok).toBe(false);
    expect(read.ok || read.response.status).toBe(400);
  });

  test("refuses a body past the limit before parsing it", async () => {
    const oversized = encode(`{"label":"${"x".repeat(LIMIT)}"}`);

    const read = await readJsonBody(raw(oversized), LIMIT);

    expect(read.ok).toBe(false);
    expect(read.ok || read.response.status).toBe(413);
  });
});
