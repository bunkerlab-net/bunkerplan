import { validateStandaloneHtml } from "../html/validate.ts";

/**
 * Reads and vets an upload body, or returns the failing response. The
 * Content-Length check rejects an oversized upload before reading it.
 */
export async function readUploadBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "text/html") {
    return Response.json(
      { error: "content-type must be text/html" },
      { status: 415 },
    );
  }

  const tooBig = `upload exceeds ${maxBytes} bytes`;
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return Response.json({ error: tooBig }, { status: 413 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    return Response.json({ error: tooBig }, { status: 413 });
  }

  const validation = validateStandaloneHtml(bytes);
  if (!validation.ok) {
    return Response.json({ error: validation.reason }, { status: 422 });
  }

  return bytes;
}
