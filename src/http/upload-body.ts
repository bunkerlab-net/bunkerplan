import { validateStandaloneHtml } from "../html/validate.ts";
import { readBoundedBody } from "./bounded-body.ts";

/**
 * Reads and vets an upload body, or returns the failing response.
 *
 * The size cap is enforced while reading rather than from `content-length` -
 * see `readBoundedBody` for why the header cannot carry that job.
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

  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes === null) {
    return Response.json(
      { error: `upload exceeds ${maxBytes} bytes` },
      { status: 413 },
    );
  }

  const validation = validateStandaloneHtml(bytes);
  if (!validation.ok) {
    return Response.json({ error: validation.reason }, { status: 422 });
  }

  return bytes;
}
