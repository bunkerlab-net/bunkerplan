import { createR2Storage } from "../../../src/storage/r2.ts";

/**
 * Runs `createR2Storage` inside workerd, where it runs in production.
 *
 * It cannot be driven from the test process. Miniflare hands the host a proxy
 * for the R2 binding, and an `R2ObjectBody` does not survive that boundary -
 * reading `.body`, or even testing for it with `in`, throws `DataCloneError`.
 * Since `get` returning a stream IS the contract, a host-side R2 suite could
 * only ever test the half of the driver that does not stream.
 *
 * So the driver is bundled into this Worker and reached over `dispatchFetch`,
 * which is also how the application uses it: `src/routes/p.$planId.tsx` pipes
 * the same stream straight into a `Response`.
 *
 * The id travels in the query string rather than the path. Ids under test
 * include `../config.json` and `/etc/passwd`, and a URL normalises its path -
 * which would silently rewrite the very input the namespacing tests exist to
 * push through the driver unchanged.
 */
export default {
  async fetch(request: Request, env: { BUCKET: R2Bucket }): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    const storage = createR2Storage(env.BUCKET);

    try {
      switch (url.pathname) {
        case "/put": {
          const body = new Uint8Array(await request.arrayBuffer());
          await storage.put(id, body);
          return new Response(null, { status: 204 });
        }
        case "/get": {
          const object = await storage.get(id);
          if (object === null) return new Response(null, { status: 404 });
          return new Response(object.body, {
            headers: {
              "x-plan-size": String(object.size),
              "x-plan-etag": object.etag,
            },
          });
        }
        case "/delete": {
          await storage.delete(id);
          return new Response(null, { status: 204 });
        }
        case "/probe": {
          await storage.probe();
          return new Response(null, { status: 204 });
        }
        default:
          return new Response(`no such operation: ${url.pathname}`, {
            status: 400,
          });
      }
    } catch (error) {
      // Surfaced as a body the fixture rethrows. A driver failure must not
      // reach the assertions as a plain non-2xx, which reads as a miss.
      return new Response(
        error instanceof Error ? error.stack : String(error),
        {
          status: 500,
        },
      );
    }
  },
};
