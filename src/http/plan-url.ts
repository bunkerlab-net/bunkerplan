/**
 * The public URL of a plan, and the one definition of the `/p/` prefix that
 * `PUT /api/plans` hands out — in the `url` field, in the `location` header and
 * in the dashboard listing, which would otherwise each carry their own copy.
 *
 * It must match the path of src/routes/p.$planId.tsx, and nothing else may be
 * routed under that prefix: see the note on `newPlanId` in src/ids.ts for why
 * the namespace is reserved.
 */
export function planUrl(publicBaseUrl: string, id: string): string {
  return `${publicBaseUrl}/p/${id}`;
}
