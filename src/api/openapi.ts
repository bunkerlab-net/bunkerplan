/**
 * The published OpenAPI 3.1 document, assembled from the Zod schemas in
 * src/api/schemas.ts rather than maintained beside them.
 *
 * `/api/auth/*` is deliberately absent. Better Auth owns every route under
 * that prefix and its surface changes with the plugin set, so describing it by
 * hand here is exactly the drift this module exists to avoid.
 */
import type { ZodType } from "zod";
import type { Config } from "../config.ts";
import { MAX_PLAN_LABEL_LENGTH } from "../http/plan-label.ts";
import { MAX_LABEL_BODY_BYTES } from "../http/relabel-plan.ts";
import { PLAN_PAGE_SIZE } from "../services/types.ts";
import {
  componentSchemas,
  ErrorBody,
  Health,
  inlineSchema,
  type JsonSchema,
  PlanCreated,
  PlanIdParam,
  PlanLabelQuery,
  PlanList,
  PlanRelabelled,
  PlanReplaced,
  RelabelRequest,
  ref,
} from "./schemas.ts";

export const API_TITLE = "BunkerPlan API";

/**
 * Not derived from anything: package.json carries no version, because the app
 * is private and deployed from a commit rather than published. It moves when
 * the wire contract does.
 */
const API_VERSION = "1.0.0";

const API_KEY_SCHEME = "apiKey";
const SESSION_SCHEME = "session";

/** Only upload, replace, and delete take a key; see src/http/require-user.ts. */
const WRITE_AUTH = [{ [API_KEY_SCHEME]: [] }, { [SESSION_SCHEME]: [] }];
const SESSION_AUTH = [{ [SESSION_SCHEME]: [] }];

/** An OpenAPI Response Object. */
export interface ResponseSpec {
  description: string;
  content?: Record<string, { schema: JsonSchema }>;
  headers?: Record<string, JsonSchema>;
}

/** An OpenAPI Path Item Object: one entry per method, plus `parameters`. */
export type PathItem = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: string;
  jsonSchemaDialect: string;
  info: {
    title: string;
    version: string;
    description: string;
    license: { name: string };
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<string, JsonSchema>;
  };
}

function json(schema: ZodType, description: string): ResponseSpec {
  return {
    description,
    content: { "application/json": { schema: ref(schema) } },
  };
}

/** Failures all carry `Error`, so they differ only in what went wrong. */
function failures(cases: Record<number, string>): Record<string, ResponseSpec> {
  return Object.fromEntries(
    Object.entries(cases).map(([status, why]) => [
      status,
      json(ErrorBody, why),
    ]),
  );
}

const UNAUTHORISED =
  "Neither an API key nor a session cookie identified a user.";
const NOT_FOUND =
  "No such plan, or it belongs to another account - the two are " +
  "indistinguishable on purpose, so an id can never be confirmed to exist.";
const UNSUPPORTED_MEDIA = "`content-type` was not `text/html`.";
const NOT_STANDALONE =
  "The document loads something external. The message names the offending " +
  "`tag[attribute]`.";
const STORAGE_DOWN = "The object store could not be reached.";

/** Upload and replace share one allowance, counted per user. */
const RATE_LIMITED: ResponseSpec = {
  ...json(
    ErrorBody,
    "The account's upload allowance is spent. `retry-after` says for how long.",
  ),
  headers: {
    "retry-after": {
      description: "Seconds until the allowance refills.",
      schema: { type: "integer", minimum: 0 },
    },
  },
};

const UPLOAD_BODY = {
  required: true,
  description: "The HTML document itself, sent as the raw body.",
  content: {
    "text/html": {
      schema: { type: "string", description: "A standalone HTML document." },
    },
  },
};

const PLAN_ID_PARAM = {
  name: "id",
  in: "path",
  required: true,
  description: "The plan id returned when the plan was created.",
  schema: inlineSchema(PlanIdParam),
};

const LABEL_QUERY_PARAM = {
  name: "label",
  in: "query",
  required: false,
  description: "Optional owner-facing name. Blank means none.",
  schema: inlineSchema(PlanLabelQuery),
};

const LOCATION_HEADER = {
  location: {
    description: "The plan's public URL, same as `url`.",
    schema: { type: "string", format: "uri" },
  },
};

/** `tooLarge` differs per deployment; everything else here is fixed. */
function createPlanOperation(tooLarge: string): Record<string, unknown> {
  return {
    operationId: "createPlan",
    summary: "Upload a plan",
    tags: ["Plans"],
    security: WRITE_AUTH,
    parameters: [LABEL_QUERY_PARAM],
    requestBody: UPLOAD_BODY,
    responses: {
      "201": {
        ...json(PlanCreated, "The plan was stored."),
        headers: LOCATION_HEADER,
      },
      ...failures({
        400: `\`label\` is longer than ${MAX_PLAN_LABEL_LENGTH} characters, or carries control or text-direction characters.`,
        401: UNAUTHORISED,
        404:
          "The account was deleted while the upload was in flight, so the " +
          "object was withdrawn rather than left with no owner.",
        409:
          "The account is at MAX_PLANS_PER_USER, or its deletion has already " +
          "begun.",
        413: tooLarge,
        415: UNSUPPORTED_MEDIA,
        422: NOT_STANDALONE,
        500: "No free plan id was found in three attempts.",
        502: STORAGE_DOWN,
      }),
      "429": RATE_LIMITED,
    },
  };
}

function replacePlanOperation(tooLarge: string): Record<string, unknown> {
  return {
    operationId: "replacePlan",
    summary: "Replace a plan's document",
    description:
      "The id, the public URL, and the label all survive; only the bytes " +
      "change. Caches hold a plan for five minutes, so a replacement can " +
      "take that long to reach a reader who has already seen the old one.",
    tags: ["Plans"],
    security: WRITE_AUTH,
    requestBody: UPLOAD_BODY,
    responses: {
      "200": json(PlanReplaced, "The document was replaced."),
      ...failures({
        401: UNAUTHORISED,
        404: NOT_FOUND,
        413: tooLarge,
        415: UNSUPPORTED_MEDIA,
        422: NOT_STANDALONE,
        502: STORAGE_DOWN,
      }),
      "429": RATE_LIMITED,
    },
  };
}

const LIST_PLANS_OPERATION = {
  operationId: "listPlans",
  summary: "List your plans",
  description: `Returns at most ${PLAN_PAGE_SIZE} plans, newest first.`,
  tags: ["Plans"],
  security: SESSION_AUTH,
  responses: {
    "200": json(PlanList, "The caller's plans."),
    ...failures({ 401: UNAUTHORISED }),
  },
};

const RELABEL_PLAN_OPERATION = {
  operationId: "relabelPlan",
  summary: "Rename a plan",
  description:
    "Session-only: an API key sets a label by supplying one on upload and " +
    "cannot edit it afterwards. Nothing outside the row changes - the object " +
    "key, the public URL, and the served document are all untouched.",
  tags: ["Plans"],
  security: SESSION_AUTH,
  requestBody: {
    required: true,
    content: { "application/json": { schema: ref(RelabelRequest) } },
  },
  responses: {
    "200": json(PlanRelabelled, "The label was set."),
    ...failures({
      400: "The body is not JSON, or `label` is missing or unusable.",
      401: UNAUTHORISED,
      404: NOT_FOUND,
      413: `The body exceeds ${MAX_LABEL_BODY_BYTES} bytes.`,
    }),
  },
};

const DELETE_PLAN_OPERATION = {
  operationId: "deletePlan",
  summary: "Delete a plan",
  description: "The id is never reissued.",
  tags: ["Plans"],
  security: WRITE_AUTH,
  responses: {
    "204": { description: "The plan is gone. No body." },
    ...failures({ 401: UNAUTHORISED, 404: NOT_FOUND, 502: STORAGE_DOWN }),
  },
};

const DOCUMENT_PATH: PathItem = {
  parameters: [PLAN_ID_PARAM],
  get: {
    operationId: "readPlan",
    summary: "Read a published plan",
    description:
      "Public and unauthenticated. Served under a `sandbox` " +
      "Content-Security-Policy, which puts the document in an opaque origin " +
      "so it cannot reach the uploader's session.",
    tags: ["Documents"],
    security: [],
    responses: {
      "200": {
        description: "The stored document.",
        content: { "text/html": { schema: { type: "string" } } },
        headers: {
          etag: { schema: { type: "string" } },
          "cache-control": {
            description: "Five minutes, revalidated.",
            schema: { type: "string" },
          },
          "content-security-policy": {
            description: "The sandbox policy. Always present.",
            schema: { type: "string" },
          },
        },
      },
      "304": { description: "`if-none-match` matched the stored etag." },
      "404": {
        description:
          "No such plan, or an id this deployment could never have issued. " +
          "The body is the site's own HTML error page.",
        content: { "text/html": { schema: { type: "string" } } },
      },
    },
  },
};

const HEALTH_PATH: PathItem = {
  get: {
    operationId: "health",
    summary: "Readiness probe",
    description:
      "A self-hosting endpoint, for a container orchestrator that has no " +
      "other way to see whether the database, the object store, and the " +
      "key-value store are reachable from inside the container. On " +
      "Cloudflare it returns a plain 404: nothing polls it there, and each " +
      "call would fan one unauthenticated public request out into three " +
      "billable backend operations.",
    tags: ["Operations"],
    security: [],
    responses: {
      "200": json(Health, "Every dependency answered."),
      "404": {
        description: "Running on Cloudflare, where the probe is refused.",
        content: { "text/plain": { schema: { type: "string" } } },
      },
      "503": json(Health, "At least one dependency did not answer."),
    },
  },
};

const INFO = {
  title: API_TITLE,
  version: API_VERSION,
  description: [
    "Upload a standalone HTML document, get a URL that opens.",
    "",
    "Uploads must be self-contained: no external scripts, stylesheets,",
    "images, iframes, or CSS `url()`/`@import` targets, including relative",
    "paths. Inline `<style>`, inline `<script>`, `data:` URIs, and ordinary",
    "links are fine.",
    "",
    "An API key authorises upload, replacement, and delete, and nothing",
    "else. Listing plans and editing a label are session-only.",
    "",
    "Registration and sign-in live under `/api/auth/*`, which Better Auth",
    "owns and which is not described here.",
  ].join("\n"),
  license: { name: "MIT" },
};

const TAGS = [
  { name: "Plans", description: "Managing your own plans." },
  { name: "Documents", description: "Reading a published plan." },
  { name: "Operations", description: "Self-hosting probes." },
];

const SECURITY_SCHEMES = {
  [API_KEY_SCHEME]: {
    type: "apiKey",
    in: "header",
    name: "x-api-key",
    description:
      "A key minted from the dashboard. Authorises upload, replacement, and " +
      "delete for its owner's plans, and nothing else.",
  },
  [SESSION_SCHEME]: {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description:
      "The dashboard session, set by a passkey ceremony under `/api/auth/*`. " +
      "Over HTTPS the cookie is named `__Secure-better-auth.session_token`.",
  },
};

/**
 * The document. Takes the two settings it actually reports, so a self-hosted
 * deployment publishes its own origin and its own upload cap rather than this
 * repository's defaults.
 */
export function openApiDocument(
  config: Pick<Config, "publicBaseUrl" | "maxUploadBytes">,
): OpenApiDocument {
  const tooLarge = `The document exceeds MAX_UPLOAD_BYTES (${config.maxUploadBytes} on this deployment). Measured while reading, not taken from \`content-length\`.`;

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: INFO,
    servers: [{ url: config.publicBaseUrl, description: "This deployment." }],
    tags: TAGS,
    paths: {
      "/api/plans": {
        put: createPlanOperation(tooLarge),
        get: LIST_PLANS_OPERATION,
      },
      "/api/plans/{id}": {
        parameters: [PLAN_ID_PARAM],
        put: replacePlanOperation(tooLarge),
        patch: RELABEL_PLAN_OPERATION,
        delete: DELETE_PLAN_OPERATION,
      },
      "/p/{id}": DOCUMENT_PATH,
      "/healthz": HEALTH_PATH,
    },
    components: {
      schemas: componentSchemas(),
      securitySchemes: SECURITY_SCHEMES,
    },
  };
}
