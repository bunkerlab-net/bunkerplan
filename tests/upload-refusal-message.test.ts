import { describe, expect, test } from "bun:test";
import { uploadPlan } from "../src/client/api.ts";

/**
 * What the dashboard shows when the gate refuses an upload. The panel renders
 * the thrown message verbatim into `.error`, which carries `white-space:
 * pre-wrap`, so a newline in the message is a line the uploader reads.
 *
 * Asserted here rather than through the real stack because the interesting part
 * is the shape of the body the client is handed, and the client is what turns a
 * list of faults into something a person can act on.
 */
describe("the message a refused upload shows", () => {
  const withBody = async (
    body: unknown,
    statusText?: string,
  ): Promise<string> => {
    const original = globalThis.fetch;
    // `Object.assign` rather than a cast: Bun's `fetch` carries statics like
    // `preconnect`, and the stub has to satisfy the same type.
    globalThis.fetch = Object.assign(
      async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 422,
          ...(statusText === undefined ? {} : { statusText }),
        }),
      { preconnect: original.preconnect },
    );
    try {
      await uploadPlan(new File(["<!doctype html>"], "p.html"), "private");
      return "no error thrown";
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    } finally {
      globalThis.fetch = original;
    }
  };
  const withFetch = (body: unknown) => withBody(body);

  test("shows the single fault when that is all there was", async () => {
    const message = await withFetch({
      error: "external reference: img[src] /logo.png",
    });
    expect(message).toBe("external reference: img[src] /logo.png");
  });

  test("shows every fault, one per line", async () => {
    const message = await withFetch({
      error: "external reference: img[src] /a.png",
      errors: [
        "external reference: img[src] /a.png",
        "external reference: img[src] /b.png",
      ],
    });
    expect(message).toBe(
      "external reference: img[src] /a.png\nexternal reference: img[src] /b.png",
    );
  });

  test("says there are more when the list was capped", async () => {
    const message = await withFetch({
      error: "external reference: img[src] /a.png",
      errors: [
        "external reference: img[src] /a.png",
        "external reference: img[src] /b.png",
      ],
      truncated: true,
    });
    expect(message.split("\n")).toEqual([
      "external reference: img[src] /a.png",
      "external reference: img[src] /b.png",
      "...and more not listed.",
    ]);
  });

  /**
   * `truncated` cannot arrive without a list from this server, but a stripped or
   * rewritten body must not reduce the message to the trailer alone.
   */
  test("never shows only the trailer", async () => {
    const message = await withFetch({
      error: "not standalone",
      truncated: true,
    });
    expect(message).toBe("not standalone");
  });

  test("falls back to the status line when the body is not JSON", async () => {
    expect(await withBody("<html>gateway</html>", "Unprocessable Entity")).toBe(
      "422 Unprocessable Entity",
    );
  });

  test("leaves no dangling space when there is no reason phrase", async () => {
    expect(await withBody("<html>gateway</html>")).toBe("422");
  });
});
