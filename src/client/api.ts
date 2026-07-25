export interface PlanSummary {
  id: string;
  url: string;
  size: number;
  createdAt: string;
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

export async function uploadPlan(file: File): Promise<PlanSummary> {
  const response = await fetch("/api/plans", {
    method: "PUT",
    headers: { "content-type": "text/html" },
    body: await file.arrayBuffer(),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { id: string; url: string };
  return {
    id: body.id,
    url: body.url,
    size: file.size,
    createdAt: new Date().toISOString(),
  };
}

export async function deletePlan(id: string): Promise<void> {
  const response = await fetch(`/api/plans/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response));
}
