/**
 * The wire shapes of the JSON API, as Zod schemas. `src/api/openapi.ts` turns
 * these into the published OpenAPI document.
 *
 * Only half of this is enforced, and the halves are worth telling apart.
 *
 * RESPONSES are load-bearing. Every JSON response body the document
 * describes is typed against a schema here at the point it is built - with
 * `satisfies` on a literal, or an explicit annotation where the body is
 * assembled first, as in `/healthz` and `problem()` - so one that stops
 * matching the published shape fails `tsc`. The `text/html` bodies on
 * `/p/{id}` are the exception: a stored plan and the site's 404 page are raw
 * `Response`s, described inline in src/api/openapi.ts rather than from a
 * schema here.
 *
 * REQUESTS are description only. Nothing here parses an incoming body or
 * query - `src/app.ts` hands the raw request to the manual parsers in
 * `src/http/*`, which own the validation and the error messages. So
 * `RelabelRequest` and `PlanLabelQuery` document what those parsers accept
 * rather than deciding it, and a change to one has to be mirrored by hand.
 *
 * Hono's `@hono/zod-openapi` fuses the two: `app.openapi(route, handler)`
 * validates from the same schema it publishes. What keeps us off it is the
 * converter, not the coupling - it reads Zod internals through
 * `@asteasolutions/zod-to-openapi` rather than calling `z.toJSONSchema`, and
 * its output differs from what this module emits today: fields with defaults
 * drop out of `required`, `additionalProperties: false` disappears,
 * `z.iso.datetime()` loses its `pattern`, and nullable renders as
 * `type: [T, "null"]`. That is a re-baseline of a published contract.
 * Everything else about the move is ordinary work: request parts are only
 * validated where a route declares them, and `defaultHook` can keep the
 * error bodies `src/http/*` already returns.
 *
 * The star import is deliberate. `import { z } from "zod"` defeats
 * tree-shaking and costs 65 KB gzip in the Worker where this costs 21 KB, for
 * identical code.
 */
import * as z from "zod";
import { MAX_SHARE_CODE_LENGTH, MIN_SHARE_CODE_LENGTH } from "../config.ts";
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

/**
 * The one sentence describing a share code's shape. Only the running
 * deployment knows the length, and `SHARE_CODE_LENGTH` is an operator
 * setting, so this cannot be baked into the module-level schema.
 */
export function shareCodeFormat(length: number): string {
  return `Mixed-case alphanumeric, ${length} characters on this deployment.`;
}

/**
 * Writes the deployment's own code format onto the two schemas that carry a
 * plaintext code, after generation. Throws rather than silently doing nothing
 * if either shape is renamed - a description that quietly vanished would be
 * indistinguishable from one that was never wanted.
 */
function describeShareCode(
  schemas: Record<string, JsonSchema>,
  id: string,
  length: number,
): void {
  const properties = schemas[id]?.["properties"];
  if (
    typeof properties !== "object" ||
    properties === null ||
    !("code" in properties)
  ) {
    throw new Error(`${id} has no code property to describe`);
  }
  const code = properties.code;
  if (typeof code !== "object" || code === null) {
    throw new Error(`${id}.code is not a schema object`);
  }
  Object.assign(code, {
    description:
      "The plaintext share code, returned this once and never again - the " +
      `column holds a digest. ${shareCodeFormat(length)}`,
  });
}

/**
 * Every registered component, as OpenAPI 3.1 schema objects.
 *
 * `shareCodeLength` is the deployment's `SHARE_CODE_LENGTH`, so a self-hosted
 * instance publishes its own value rather than this repository's default.
 */
export function componentSchemas(
  shareCodeLength: number,
): Record<string, JsonSchema> {
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

  describeShareCode(schemas, "PlanCreated", shareCodeLength);
  describeShareCode(schemas, "ShareCodeCreated", shareCodeLength);

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
  description:
    "Where the document is served. Who may read it depends on the plan's " +
    "visibility; a private one gates this URL.",
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
    description: "The error body returned by failing plan API operations.",
  }),
);

/**
 * The body types the handlers write. Each shares its schema's name - a value
 * and a type may, and here should: `Response.json(body satisfies PlanCreated)`
 * is what makes a handler that drifts from the published document fail `tsc`
 * instead of shipping a spec that lies.
 */
export type ErrorBody = z.infer<typeof ErrorBody>;

/**
 * What a plan's `visibility` column holds. `code` is an upload intent, not a
 * stored state - see `PlanVisibilityQuery`.
 */
export const PlanVisibility = component(
  "PlanVisibility",
  z.enum(["public", "private"]).meta({
    title: "PlanVisibility",
    description:
      "public: anyone holding the URL may read it. private: only the owner, " +
      "the accounts it has been granted to, and anyone holding its share code.",
  }),
);

/** Handles are what a grant is addressed by; `user.name` is the handle. */
const PlanHandle = z.string().meta({
  description: "An account handle, as shown in the dashboard.",
  examples: ["k7mjq2rvxn"],
});

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
      visibility: PlanVisibility,
      hasShareCode: z.boolean().meta({
        description:
          "True when a share code is set. The code itself is stored as a " +
          "digest and is never returned after the request that minted it.",
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
    .object({
      id: PlanId,
      url: PlanUrl,
      label: PlanLabel,
      // `describeShareCode` writes this field's description at document
      // build time, because it names a per-deployment length.
      code: z.string().optional(),
    })
    .meta({ title: "PlanCreated" }),
);

export type PlanCreated = z.infer<typeof PlanCreated>;

export const PlanSharing = component(
  "PlanSharing",
  z
    .object({
      visibility: PlanVisibility,
      // Same name as `PlanSummary.hasShareCode`: both are the JSON API
      // reporting the same fact, and two spellings for one field is a trap.
      hasShareCode: z.boolean().meta({
        description: "True when a share code is set.",
      }),
      grants: z.array(PlanHandle).meta({
        description: "Handles of the accounts this plan is shared with.",
      }),
    })
    .meta({ title: "PlanSharing" }),
);

export type PlanSharing = z.infer<typeof PlanSharing>;

export const ShareCodeCreated = component(
  "ShareCodeCreated",
  z
    .object({
      code: z.string(),
    })
    .meta({ title: "ShareCodeCreated" }),
);

export type ShareCodeCreated = z.infer<typeof ShareCodeCreated>;

/**
 * The bounds are the stable ones, not this deployment's
 * `SHARE_CODE_LENGTH`: lowering that setting must not stop a code minted
 * under the old one from being redeemed.
 */
const ShareCodeValue = z
  .string()
  .regex(/^[0-9A-Za-z]+$/)
  .min(MIN_SHARE_CODE_LENGTH)
  .max(MAX_SHARE_CODE_LENGTH);

export const UnlockRequest = component(
  "UnlockRequest",
  z
    .looseObject({ code: ShareCodeValue })
    .meta({ title: "UnlockRequest", description: "A plaintext share code." }),
);

export const GrantRequest = component(
  "GrantRequest",
  z.looseObject({ handle: PlanHandle }).meta({
    title: "GrantRequest",
    description: "The account to grant, addressed by handle.",
  }),
);

export const SharingRequest = component(
  "SharingRequest",
  z.looseObject({ visibility: PlanVisibility }).meta({
    title: "SharingRequest",
    description:
      "Flips a plan between public and private. Giving a plan a share code " +
      "is POST /api/plans/{id}/share-code, because that is the request that " +
      "returns the plaintext.",
  }),
);

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

/**
 * The optional `?visibility=` on upload. `code` is an intent rather than a
 * stored state: it stores `private` and mints a share code in the same
 * statement.
 */
export const PlanVisibilityQuery = z.enum(["public", "private", "code"]).meta({
  description:
    "Who may read the new plan. Defaults to private. `code` stores it " +
    "private and mints a share code, returned once in the response body.",
});

/** The optional `?code=` on a plan document. */
export const ShareCodeQuery = ShareCodeValue.meta({
  description:
    "A share code. Grants access to this one plan and sets a path-scoped " +
    "cookie, so the parameter is only needed once per reader.",
});

/** The `{id}` path parameter, which is a plan id. */
export const PlanIdParam = PlanId;
