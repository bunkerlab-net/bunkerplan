import { problem } from "./problem.ts";

/**
 * Reads a request body, refusing one that runs past a byte budget.
 *
 * The obvious spelling - compare `content-length`, then `arrayBuffer()` -
 * enforces nothing. `Number("")` is `0`, so a body with no declared length
 * passes the comparison, and HTTP/2 and `Transfer-Encoding: chunked` do not
 * declare one. The whole body then lands in memory before anything measures
 * it. Counting while reading is the only version that holds, so the declared
 * length is kept purely as a way to refuse early rather than as the control.
 *
 * `null` means the body exceeded the budget; the caller decides the status.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the sender rather than draining bytes we have already refused.
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0];

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * The same read, for the routes whose body is JSON: either the parsed value or
 * the response that refuses it.
 *
 * One vocabulary, because three handlers each spelled this out and a fourth
 * would have invented a fourth wording. Over the budget is 413 `body exceeds N
 * bytes`; anything that will not parse is 400 `body must be JSON`. The two
 * stay separate statuses on purpose - a body over the ceiling is a different
 * fact from a malformed one, and answering the same status for both would be
 * this codebase disagreeing with itself about the same condition.
 *
 * What is *inside* the parsed value is the caller's business. A JSON object
 * that omits the field a route needs is not a malformed body, so each handler
 * still names its own missing-field refusal.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const encoded = await readBoundedBody(request, maxBytes);
  if (encoded === null) {
    return {
      ok: false,
      response: problem(413, `body exceeds ${maxBytes} bytes`),
    };
  }

  try {
    // `fatal`, so a malformed byte sequence throws here rather than being
    // replaced with U+FFFD and parsed. Silently substituting is the worse
    // ending: a bad byte inside a JSON string leaves the parse succeeding and
    // stores the replacement character, so a label arrives subtly corrupted
    // instead of being refused. Both paths answer 400 - this decides which
    // inputs reach it.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: problem(400, "body must be JSON") };
  }
}
