export type PlanVisibility = "public" | "private";

export interface PlanSummary {
  id: string;
  url: string;
  label: string | null;
  size: number;
  createdAt: string;
  visibility: PlanVisibility;
  hasShareCode: boolean;
}

export interface PlanSharing {
  visibility: PlanVisibility;
  hasShareCode: boolean;
  /** Handles of the accounts this plan is shared with. */
  grants: string[];
}

/**
 * What naming a set of accounts did. Declared here rather than imported from
 * src/api/schemas.ts, like every other shape in this module: that one pulls
 * in zod, which has no business in the browser bundle.
 */
export interface GrantResult {
  granted: string[];
  unknown: string[];
  failed: string[];
}

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
    ) {
      return body.error;
    }
  } catch {
    // Fall through to the status line.
  }
  return `${response.status} ${response.statusText}`;
}

export async function listPlans(): Promise<PlanSummary[]> {
  const response = await fetch("/api/plans");
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { plans: PlanSummary[] };
  return body.plans;
}

export async function uploadPlan(
  file: File,
  visibility: PlanVisibility,
): Promise<PlanSummary> {
  const response = await fetch(`/api/plans?visibility=${visibility}`, {
    method: "PUT",
    headers: { "content-type": "text/html" },
    body: await file.arrayBuffer(),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { id: string; url: string };
  return {
    id: body.id,
    url: body.url,
    label: null,
    size: file.size,
    createdAt: new Date().toISOString(),
    visibility,
    hasShareCode: false,
  };
}

export async function relabelPlan(
  id: string,
  label: string | null,
): Promise<void> {
  const response = await fetch(`/api/plans/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function deletePlan(id: string): Promise<void> {
  const response = await fetch(`/api/plans/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response));
}

/** Overwrites the document behind `id`; the id, URL, and label all survive. */
export async function replacePlan(id: string, file: File): Promise<void> {
  const response = await fetch(`/api/plans/${id}`, {
    method: "PUT",
    headers: { "content-type": "text/html" },
    body: await file.arrayBuffer(),
  });
  if (!response.ok) throw new Error(await readError(response));
}

export async function getSharing(id: string): Promise<PlanSharing> {
  const response = await fetch(`/api/plans/${id}/sharing`);
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as PlanSharing;
}

export async function setVisibility(
  id: string,
  visibility: PlanVisibility,
): Promise<PlanSharing> {
  const response = await fetch(`/api/plans/${id}/sharing`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visibility }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as PlanSharing;
}

/**
 * Mints a code and returns the plaintext. This is the only time it is ever
 * returned - there is no endpoint that reads it back.
 */
export async function rotateShareCode(id: string): Promise<string> {
  const response = await fetch(`/api/plans/${id}/share-code`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { code: string };
  return body.code;
}

export async function clearShareCode(id: string): Promise<void> {
  const response = await fetch(`/api/plans/${id}/share-code`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await readError(response));
}

/**
 * Shares a plan with everyone named. `accounts` goes over as typed - the
 * server splits on commas - so the dashboard field takes a list without the
 * client having to agree separately on how one is written.
 *
 * Returns the handles that landed and the ones no account answers to; a
 * mistyped name is reported rather than refusing the rest.
 */
export async function addGrants(
  id: string,
  accounts: string,
): Promise<GrantResult> {
  const response = await fetch(`/api/plans/${id}/grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accounts }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as GrantResult;
}

export async function removeGrant(id: string, handle: string): Promise<void> {
  const response = await fetch(
    `/api/plans/${id}/grants/${encodeURIComponent(handle)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(await readError(response));
}

/** Trades a share code for the unlock cookie. Unauthenticated by design. */
export async function unlockPlan(id: string, code: string): Promise<void> {
  const response = await fetch(`/api/plans/${id}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  // The gate page is this route's only caller, and "rate limit exceeded" tells
  // a reader who mistyped a code nothing they can act on. `retry-after` is on
  // the response, so the wait is named instead.
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new Error(
      Number.isFinite(seconds) && seconds > 0
        ? `Too many attempts. Try again in ${seconds} seconds.`
        : "Too many attempts. Try again shortly.",
    );
  }
  if (!response.ok) throw new Error(await readError(response));
}
