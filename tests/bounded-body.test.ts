import { describe, expect, test } from "bun:test";
import { readBoundedBody } from "../src/http/bounded-body.ts";

const LIMIT = 1024;

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
