import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type FetchResponse,
  type Harness,
  html,
  PUBLIC_BASE_URL,
  startWorker,
  UPLOAD_RATE_MAX,
  upload,
} from "./harness.ts";

let app: Harness;

beforeAll(async () => {
  app = await startWorker();
});

afterAll(async () => {
  await app.close();
});

interface Created {
  id: string;
  url: string;
  label: string | null;
}

/** `Response.json()` erases the body; assertions need something to compare. */
async function jsonBody(
  response: FetchResponse,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function createPlan(
  key: string,
  body: string,
  label?: string,
): Promise<Created> {
  const query =
    label === undefined ? "" : `?label=${encodeURIComponent(label)}`;
  const response = await app.fetch(`/api/plans${query}`, upload(key, body));
  expect(response.status).toBe(201);
  return (await response.json()) as Created;
}

async function storedSize(id: string): Promise<number | null> {
  const row = await app.db
    .prepare("select size from plan where id = ?")
    .bind(id)
    .first<{ size: number }>();
  return row?.size ?? null;
}

async function storedLabel(id: string): Promise<string | null> {
  const row = await app.db
    .prepare("select label from plan where id = ?")
    .bind(id)
    .first<{ label: string | null }>();
  return row?.label ?? null;
}

describe("plan lifecycle over HTTP", () => {
  test("refuses an upload with no credential", async () => {
    const response = await app.fetch("/api/plans", {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: html("anonymous"),
    });
    expect(response.status).toBe(401);
  });

  test("uploads a plan and serves it sandboxed at its public URL", async () => {
    const key = await app.account();
    const body = html("published");
    const created = await createPlan(key, body, "Q3 rollout");

    expect(created.url).toBe(`${PUBLIC_BASE_URL}/p/${created.id}`);
    expect(created.label).toBe("Q3 rollout");
    expect(await storedSize(created.id)).toBe(body.length);

    const served = await app.fetch(`/p/${created.id}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(body);
    expect(served.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups",
    );
  });

  test("replaces the document behind an id, keeping the URL and the label", async () => {
    const key = await app.account();
    const created = await createPlan(key, html("before"), "keep me");

    const revised = html("after, and rather longer than before");
    const response = await app.fetch(
      `/api/plans/${created.id}`,
      upload(key, revised),
    );

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({
      id: created.id,
      url: created.url,
    });
    expect(await (await app.fetch(`/p/${created.id}`)).text()).toBe(revised);
    expect(await storedSize(created.id)).toBe(revised.length);
    expect(await storedLabel(created.id)).toBe("keep me");
  });

  test("refuses a replacement from another account and leaves the plan alone", async () => {
    const owner = await app.account();
    const stranger = await app.account();
    const body = html("mine");
    const created = await createPlan(owner, body);

    const response = await app.fetch(
      `/api/plans/${created.id}`,
      upload(stranger, html("hijacked")),
    );

    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toEqual({ error: "not found" });
    expect(await (await app.fetch(`/p/${created.id}`)).text()).toBe(body);
    expect(await storedSize(created.id)).toBe(body.length);
  });

  test("refuses a replacement for an id that does not exist", async () => {
    const key = await app.account();
    const response = await app.fetch(
      "/api/plans/nosuchplanid",
      upload(key, html("nobody")),
    );
    // The JSON body is the point: an unrouted PUT would also be a 404, but an
    // HTML one, and this test would pass with the handler missing entirely.
    expect(response.status).toBe(404);
    expect(await jsonBody(response)).toEqual({ error: "not found" });
  });

  test("refuses a replacement that is not standalone, keeping the old document", async () => {
    const key = await app.account();
    const body = html("intact");
    const created = await createPlan(key, body);

    const response = await app.fetch(
      `/api/plans/${created.id}`,
      upload(
        key,
        '<!doctype html><html><body><script src="https://cdn.example.com/x.js"></script></body></html>',
      ),
    );

    expect(response.status).toBe(422);
    expect(await (await app.fetch(`/p/${created.id}`)).text()).toBe(body);
    expect(await storedSize(created.id)).toBe(body.length);
  });

  test("counts replacements against the same allowance as uploads", async () => {
    const key = await app.account();
    const created = await createPlan(key, html("first"));

    // One upload is already spent, so the remaining allowance runs out partway
    // through this loop; the point is that a replacement is what spends it.
    let refused: FetchResponse | null = null;
    for (let attempt = 1; attempt < UPLOAD_RATE_MAX + 1; attempt += 1) {
      const response = await app.fetch(
        `/api/plans/${created.id}`,
        upload(key, html(`revision ${attempt}`)),
      );
      if (response.status === 429) {
        refused = response;
        break;
      }
      expect(response.status).toBe(200);
    }

    expect(refused).not.toBeNull();
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("deletes only for the owner, and takes the URL out of service", async () => {
    const owner = await app.account();
    const stranger = await app.account();
    const created = await createPlan(owner, html("temporary"));

    const refused = await app.fetch(`/api/plans/${created.id}`, {
      method: "DELETE",
      headers: { "x-api-key": stranger },
    });
    expect(refused.status).toBe(404);
    expect((await app.fetch(`/p/${created.id}`)).status).toBe(200);

    const deleted = await app.fetch(`/api/plans/${created.id}`, {
      method: "DELETE",
      headers: { "x-api-key": owner },
    });
    expect(deleted.status).toBe(204);
    expect((await app.fetch(`/p/${created.id}`)).status).toBe(404);
    expect(await storedSize(created.id)).toBeNull();
  });
});
