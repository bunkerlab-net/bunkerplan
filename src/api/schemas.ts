/**
 * The wire shapes of the JSON API, as Zod schemas.
 *
 * This module is the source of truth for what `/api/*` accepts and sends.
 * `src/api/openapi.ts` turns these into the published document, and the
 * handlers type their response bodies against them with `satisfies`, so a body
 * that stops matching the spec fails `tsc` instead of shipping a document that
 * quietly lies.
 *
 * The star import is deliberate. `import { z } from "zod"` defeats
 * tree-shaking and costs 65 KB gzip in the Worker where this costs 21 KB, for
 * identical code.
 */
import * as z from "zod";
import { MAX_PLAN_LABEL_LENGTH } from "../http/plan-label.ts";

/**
 * The schemas that become `components.schemas` entries. Anything not
 * registered here is inlined at its use site, which is what should happen to a
 * one-off shape - a `$ref` is only worth its indirection when it is shared.
 *
 * Separate from `z.globalRegistry` on purpose: that one lives on `globalThis`
 * and already carries whatever Better Auth registered in the same Zod copy.
 */
const components = z.registry<{ id: string }>();

function component<T extends z.ZodType>(id: string, schema: T): T {
  components.add(schema, { id });
  return schema;
}

/**
 * The `$ref` for a registered schema, looked up rather than spelled out, so a
 * path that names a component nothing exports fails at boot instead of
 * shipping a dangling pointer into the document.
 */
export function ref(schema: z.ZodType): { $ref: string } {
  const id = components.get(schema)?.id;
  if (id === undefined) {
    throw new Error("schema is not a registered component");
  }
  return { $ref: `#/components/schemas/${id}` };
}

/** A JSON Schema object, as it appears inside the OpenAPI document. */
export type JsonSchema = Record<string, unknown>;

/** Every registered component, as OpenAPI 3.1 schema objects. */
export function componentSchemas(): Record<string, JsonSchema> {
  const { schemas } = z.toJSONSchema(components, {
    // OpenAPI 3.1's Schema Object *is* JSON Schema 2020-12.
    target: "draft-2020-12",
    uri: (id) => `#/components/schemas/${id}`,
  });

  // A schema that is shared but unregistered is emitted under a synthetic
  // `__shared` key and referenced as `#/components/schemas/__shared#/$defs/x`
  // - two fragments, which is not a JSON Pointer and resolves nowhere. Every
  // shared schema above goes through `component`, so this cannot happen; the
  // check is here because the failure is silent otherwise.
  if ("__shared" in schemas) {
    throw new Error("a shared schema is missing from the component registry");
  }

  for (const schema of Object.values(schemas)) {
    // `$id` restates the ref the document already reaches the schema by, and
    // `$schema` restates `jsonSchemaDialect`. Both are legal in 3.1 and both
    // are noise in a rendered reference.
    delete schema.$id;
    delete schema.$schema;
  }

  return schemas;
}

/**
 * A schema used in exactly one place - a path or query parameter - as an
 * inline JSON Schema rather than a `$ref` into `components`.
 */
export function inlineSchema(schema: z.ZodType): JsonSchema {
  const json: JsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" });
  delete json["$schema"];
  return json;
}

const PlanId = z.string().meta({
  description:
    "The plan's identity and the last path segment of its public URL. " +
    "Lowercase alphanumeric; the length is set by PLAN_ID_LENGTH and " +
    "defaults to 16.",
  examples: ["k3mp7q2xr9vt4nzb"],
});

const PlanUrl = z.url().meta({
  description: "Where the document is publicly readable.",
  examples: ["https://plan.example.com/p/k3mp7q2xr9vt4nzb"],
});

/**
 * Owner-facing text. Never part of the stored object and never part of the
 * public URL - the id stays the identity. Blank is stored as `null`, so an
 * unlabelled plan and a plan labelled `"   "` are the same thing.
 */
const PlanLabel = z
  .string()
  .max(MAX_PLAN_LABEL_LENGTH)
  .nullable()
  .meta({
    description: `Owner-facing name, at most ${MAX_PLAN_LABEL_LENGTH} characters after trimming. Control and text-direction characters are refused.`,
    examples: ["Q3 rollout"],
  });

export const ErrorBody = component(
  "Error",
  z.object({ error: z.string().meta({ examples: ["not found"] }) }).meta({
    title: "Error",
    description: "The body of every failing request.",
  }),
);

/**
 * The body types the handlers write. Each shares its schema's name - a value
 * and a type may, and here should: `Response.json(body satisfies PlanCreated)`
 * is what makes a handler that drifts from the published document fail `tsc`
 * instead of shipping a spec that lies.
 */
export type ErrorBody = z.infer<typeof ErrorBody>;

export const PlanSummary = component(
  "PlanSummary",
  z
    .object({
      id: PlanId,
      url: PlanUrl,
      label: PlanLabel,
      size: z
        .number()
        .int()
        .min(0)
        .meta({ description: "Size of the stored document, in bytes." }),
      createdAt: z.iso.datetime().meta({
        description: "When the plan was created, as RFC 3339 UTC.",
      }),
    })
    .meta({ title: "PlanSummary", description: "One row of the plan list." }),
);

export const PlanList = component(
  "PlanList",
  z
    .object({
      plans: z.array(PlanSummary),
      truncated: z.boolean().meta({
        description:
          "True when the account holds more plans than one page returns. " +
          "The page size is fixed and independent of MAX_PLANS_PER_USER, so " +
          "lowering the quota does not hide rows written under the old one.",
      }),
    })
    .meta({ title: "PlanList" }),
);

export type PlanList = z.infer<typeof PlanList>;

export const PlanCreated = component(
  "PlanCreated",
  z
    .object({ id: PlanId, url: PlanUrl, label: PlanLabel })
    .meta({ title: "PlanCreated" }),
);

export type PlanCreated = z.infer<typeof PlanCreated>;

export const PlanReplaced = component(
  "PlanReplaced",
  z.object({ id: PlanId, url: PlanUrl }).meta({ title: "PlanReplaced" }),
);

export type PlanReplaced = z.infer<typeof PlanReplaced>;

export const PlanRelabelled = component(
  "PlanRelabelled",
  z.object({ id: PlanId, label: PlanLabel }).meta({ title: "PlanRelabelled" }),
);

export type PlanRelabelled = z.infer<typeof PlanRelabelled>;

/**
 * `looseObject` rather than `object`: the handler reads `label` and ignores
 * everything else, and a strict schema here would publish
 * `additionalProperties: false` for a request that does not enforce it.
 */
export const RelabelRequest = component(
  "RelabelRequest",
  z.looseObject({ label: PlanLabel }).meta({
    title: "RelabelRequest",
    description: "Sending `null` clears the label.",
  }),
);

export const Health = component(
  "Health",
  z
    .object({
      status: z.enum(["ok", "error"]),
      checks: z
        .record(z.string(), z.enum(["ok", "error"]))
        .meta({ description: "One entry per probed dependency." }),
    })
    .meta({
      title: "Health",
      description:
        "Why a check failed is logged and never returned: the endpoint is " +
        "unauthenticated and a driver error can carry a connection string.",
    }),
);

export type Health = z.infer<typeof Health>;

/** The optional `?label=` on upload. Absent and blank both mean unlabelled. */
export const PlanLabelQuery = z
  .string()
  .max(MAX_PLAN_LABEL_LENGTH)
  .meta({
    description: `Owner-facing name for the new plan, at most ${MAX_PLAN_LABEL_LENGTH} characters after trimming.`,
    examples: ["Q3 rollout"],
  });

/** The `{id}` path parameter, which is a plan id. */
export const PlanIdParam = PlanId;
