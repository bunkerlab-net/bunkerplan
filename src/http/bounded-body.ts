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
