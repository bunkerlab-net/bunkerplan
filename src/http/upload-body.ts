import { validateStandaloneHtml } from "../html/validate.ts";
import { readBoundedBody } from "./bounded-body.ts";
import { problem } from "./problem.ts";

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
    return problem(415, "content-type must be text/html");
  }

  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes === null) {
    return problem(413, `upload exceeds ${maxBytes} bytes`);
  }

  const validation = validateStandaloneHtml(bytes);
  if (!validation.ok) {
    return problem(422, validation.reason);
  }

  return bytes;
}
