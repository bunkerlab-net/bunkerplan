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
  GrantRequest,
  Health,
  inlineSchema,
  type JsonSchema,
  PlanCreated,
  PlanHandleParam,
  PlanIdParam,
  PlanLabelQuery,
  PlanList,
  PlanRelabelled,
  PlanReplaced,
  PlanSharing,
  PlanVisibilityQuery,
  RelabelRequest,
  ref,
  ShareCodeCreated,
  ShareCodeQuery,
  SharingRequest,
  shareCodeFormat,
  UnlockRequest,
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

/**
 * A key acts for its owner on upload, replacement, delete, and reading a plan
 * that owner may read. See src/http/require-user.ts.
 */
const WRITE_AUTH = [{ [API_KEY_SCHEME]: [] }, { [SESSION_SCHEME]: [] }];
/**
 * A public plan needs no credential and a private one needs either. The
 * leading empty Security Requirement Object is how OpenAPI 3.1 spells
 * "optional here".
 */
const OPTIONAL_AUTH = [{}, { [API_KEY_SCHEME]: [] }, { [SESSION_SCHEME]: [] }];
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

const VISIBILITY_QUERY_PARAM = {
  name: "visibility",
  in: "query",
  required: false,
  description: "Who may read the new plan. Defaults to private.",
  schema: inlineSchema(PlanVisibilityQuery),
};

const HANDLE_PATH_PARAM = {
  name: "handle",
  in: "path",
  required: true,
  description: "The granted account's handle.",
  schema: inlineSchema(PlanHandleParam),
};

const LOCATION_HEADER = {
  location: {
    description: "The plan's public URL, same as `url`.",
    schema: { type: "string", format: "uri" },
  },
};

/** `tooLarge` and the code format differ per deployment. */
function createPlanOperation(
  tooLarge: string,
  codeFormat: string,
): Record<string, unknown> {
  return {
    operationId: "createPlan",
    summary: "Upload a plan",
    tags: ["Plans"],
    security: WRITE_AUTH,
    description:
      "`?visibility=code` stores the plan private and mints a share code, " +
      `returned once as \`code\` in the response body (${codeFormat}) ` +
      "and never readable afterwards. Compose the share link by appending " +
      "`?code=` to `url`.",
    parameters: [LABEL_QUERY_PARAM, VISIBILITY_QUERY_PARAM],
    requestBody: UPLOAD_BODY,
    responses: {
      "201": {
        ...json(PlanCreated, "The plan was stored."),
        headers: LOCATION_HEADER,
      },
      ...failures({
        400: `\`label\` is longer than ${MAX_PLAN_LABEL_LENGTH} characters or carries control or text-direction characters, or \`visibility\` is not public, private, or code.`,
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
      "change. A public plan is served `public, no-cache`, so a reader who " +
      "already has the old one revalidates and picks the new bytes up at once.",
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

/**
 * Sharing is session-only, and deliberately not widened to match the read
 * gate. A key already reads, replaces, and deletes its owner's plans; letting
 * it hand out access to other people would turn a leaked key from a data-loss
 * problem into a persistent backdoor.
 */
const SHARING_NOTE =
  "Session-only. An API key reads and writes its owner's plans but cannot " +
  "change who else may read them.";

const GET_SHARING_OPERATION = {
  operationId: "getPlanSharing",
  summary: "Read a plan's sharing state",
  description: SHARING_NOTE,
  tags: ["Sharing"],
  security: SESSION_AUTH,
  responses: {
    "200": json(PlanSharing, "Who may read this plan."),
    ...failures({ 401: UNAUTHORISED, 404: NOT_FOUND }),
  },
};

const SET_SHARING_OPERATION = {
  operationId: "setPlanSharing",
  summary: "Make a plan public or private",
  description:
    `${SHARING_NOTE} Giving a plan a share code is a separate request, ` +
    "because that is the one that returns a plaintext code. A plan flipped " +
    "to private stops being served at once: a public plan carries " +
    "`public, no-cache`, so every read revalidates against this API.",
  tags: ["Sharing"],
  security: SESSION_AUTH,
  requestBody: {
    required: true,
    content: { "application/json": { schema: ref(SharingRequest) } },
  },
  responses: {
    "200": json(PlanSharing, "The new sharing state."),
    ...failures({
      400: "The body is not JSON, or `visibility` is not public or private.",
      401: UNAUTHORISED,
      404: NOT_FOUND,
      413: "The body is too large to be this request.",
    }),
  },
};

function rotateShareCodeOperation(codeFormat: string): Record<string, unknown> {
  return {
    operationId: "rotateShareCode",
    summary: "Mint a share code",
    description:
      `${SHARING_NOTE} Returns the plaintext code once; nothing reads it ` +
      `back afterwards (${codeFormat}). Calling this again replaces the ` +
      "code and immediately invalidates every unlock cookie issued under " +
      "the old one.",
    tags: ["Sharing"],
    security: SESSION_AUTH,
    responses: {
      "201": json(ShareCodeCreated, "The new code, shown this once."),
      ...failures({ 401: UNAUTHORISED, 404: NOT_FOUND }),
    },
  };
}

const CLEAR_SHARE_CODE_OPERATION = {
  operationId: "clearShareCode",
  summary: "Remove a plan's share code",
  description: `${SHARING_NOTE} Existing unlock cookies stop working.`,
  tags: ["Sharing"],
  security: SESSION_AUTH,
  responses: {
    "204": { description: "The plan has no share code. No body." },
    ...failures({ 401: UNAUTHORISED, 404: NOT_FOUND }),
  },
};

const GRANT_PLAN_OPERATION = {
  operationId: "grantPlan",
  summary: "Share a plan with an account",
  description:
    `${SHARING_NOTE} Granting the same handle twice succeeds: the state ` +
    "asked for already holds.",
  tags: ["Sharing"],
  security: SESSION_AUTH,
  requestBody: {
    required: true,
    content: { "application/json": { schema: ref(GrantRequest) } },
  },
  responses: {
    "204": { description: "The account may now read this plan. No body." },
    ...failures({
      400: "The body is not JSON, or `handle` is missing or blank.",
      401: UNAUTHORISED,
      404: `${NOT_FOUND} Also returned, with a distinct message, when no account holds that handle.`,
      413: "The body is too large to be this request.",
    }),
  },
};

const REVOKE_GRANT_OPERATION = {
  operationId: "revokePlanGrant",
  summary: "Stop sharing a plan with an account",
  description: SHARING_NOTE,
  tags: ["Sharing"],
  security: SESSION_AUTH,
  responses: {
    "204": { description: "The grant is gone. No body." },
    ...failures({
      401: UNAUTHORISED,
      404: `${NOT_FOUND} Also returned when that handle held no grant.`,
    }),
  },
};

const UNLOCK_PLAN_OPERATION = {
  operationId: "unlockPlan",
  summary: "Redeem a share code",
  description:
    "Unauthenticated: this is what the gate page calls. A correct code sets " +
    "a path-scoped, HttpOnly cookie for this one plan, after which `/p/{id}` " +
    "serves it with no parameter and no session. Deliberately unlimited - a " +
    "code carries about 95 bits, so a limiter buys nothing against guessing " +
    "while an anonymous one would let a passer-by lock out the owner's link.",
  tags: ["Sharing"],
  security: [],
  requestBody: {
    required: true,
    content: { "application/json": { schema: ref(UnlockRequest) } },
  },
  responses: {
    "204": {
      description: "The code matched. No body.",
      headers: {
        "set-cookie": {
          description: "The unlock cookie, scoped to `/p/{id}`.",
          schema: { type: "string" },
        },
      },
    },
    ...failures({
      400: "The body is not JSON, or `code` is missing or not a string.",
      401: "The code did not match.",
      404: "No such plan, or it has no share code - the two are indistinguishable on purpose.",
    }),
  },
};

const CODE_QUERY_PARAM = {
  name: "code",
  in: "query",
  required: false,
  description:
    "A share code. Needed once: the response also sets a path-scoped cookie, " +
    "so a reader that keeps cookies never sends it again. Being a query " +
    "parameter it does travel in the URL, where it can reach browser " +
    "history, a `Referer` header, and any proxy that logs query strings - " +
    "regenerate the code to invalidate a link that has leaked. This app logs " +
    "no URLs. `POST /api/plans/{id}/unlock` redeems a code in a body instead.",
  schema: inlineSchema(ShareCodeQuery),
};

const DOCUMENT_PATH: PathItem = {
  parameters: [PLAN_ID_PARAM, CODE_QUERY_PARAM],
  get: {
    operationId: "readPlan",
    summary: "Read a published plan",
    description:
      "A public plan needs no credential. A private one needs any one of: " +
      "its share code as `?code=`, the unlock cookie a previous `?code=` or " +
      "redemption set, an API key whose owner may read it, or a session for " +
      "the owner or a granted account. Anything else gets 401 and an HTML " +
      "gate page.\n\n" +
      "Served under a `sandbox` Content-Security-Policy, which puts the " +
      "document in an opaque origin so it cannot reach the uploader's " +
      "session.",
    tags: ["Documents"],
    security: OPTIONAL_AUTH,
    responses: {
      "200": {
        description: "The stored document.",
        content: { "text/html": { schema: { type: "string" } } },
        headers: {
          etag: { schema: { type: "string" } },
          "cache-control": {
            description:
              "`public, no-cache` for a public plan, which a cache may store " +
              "but must revalidate on every read; " +
              "`private, no-store` for a private one, which also carries " +
              "`vary: cookie, x-api-key`.",
            schema: { type: "string" },
          },
          "set-cookie": {
            description:
              "Present when `?code=` was what granted access: the unlock " +
              "cookie, so the parameter is not needed again.",
            schema: { type: "string" },
          },
          "content-security-policy": {
            description: "The sandbox policy. Always present.",
            schema: { type: "string" },
          },
        },
      },
      "304": { description: "`if-none-match` matched the stored etag." },
      "401": {
        description:
          "The plan is private and nothing presented authorises reading it. " +
          "The body is the gate page, which offers a code box and a sign-in " +
          "button. Not 200, because the sandbox policy is pinned to 200 and " +
          "304 and would leave that page unable to do either.",
        content: { "text/html": { schema: { type: "string" } } },
      },
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
    "Plans are private by default. A private plan is readable by its owner,",
    "by accounts it has been granted to, and by anyone holding its share",
    "code; a public one by anyone holding its URL.",
    "",
    "An API key authorises upload, replacement, delete, and reading any plan",
    "its owner may read. Listing plans, editing a label, and every sharing",
    "route are session-only - a key cannot change who may read a plan.",
    "",
    "Registration and sign-in live under `/api/auth/*`, which Better Auth",
    "owns and which is not described here.",
  ].join("\n"),
  license: { name: "MIT" },
};

const TAGS = [
  { name: "Plans", description: "Managing your own plans." },
  { name: "Sharing", description: "Who may read a plan." },
  { name: "Documents", description: "Reading a published plan." },
  { name: "Operations", description: "Self-hosting probes." },
];

const SECURITY_SCHEMES = {
  [API_KEY_SCHEME]: {
    type: "apiKey",
    in: "header",
    name: "x-api-key",
    description:
      "A key minted from the dashboard. Acts for its owner on upload, " +
      "replacement, delete, and reading any plan that owner may read. It " +
      "cannot list plans, edit a label, or change who a plan is shared with.",
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
 * The document. Takes the three settings it actually reports, so a
 * self-hosted deployment publishes its own origin, its own upload cap, and
 * its own share-code length rather than this repository's defaults.
 */
export function openApiDocument(
  config: Pick<Config, "publicBaseUrl" | "maxUploadBytes" | "shareCodeLength">,
): OpenApiDocument {
  const tooLarge = `The document exceeds MAX_UPLOAD_BYTES (${config.maxUploadBytes} on this deployment). Measured while reading, not taken from \`content-length\`.`;
  const codeFormat = shareCodeFormat(config.shareCodeLength);

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: INFO,
    servers: [{ url: config.publicBaseUrl, description: "This deployment." }],
    tags: TAGS,
    paths: {
      "/api/plans": {
        put: createPlanOperation(tooLarge, codeFormat),
        get: LIST_PLANS_OPERATION,
      },
      "/api/plans/{id}": {
        parameters: [PLAN_ID_PARAM],
        put: replacePlanOperation(tooLarge),
        patch: RELABEL_PLAN_OPERATION,
        delete: DELETE_PLAN_OPERATION,
      },
      "/api/plans/{id}/sharing": {
        parameters: [PLAN_ID_PARAM],
        get: GET_SHARING_OPERATION,
        put: SET_SHARING_OPERATION,
      },
      "/api/plans/{id}/share-code": {
        parameters: [PLAN_ID_PARAM],
        post: rotateShareCodeOperation(codeFormat),
        delete: CLEAR_SHARE_CODE_OPERATION,
      },
      "/api/plans/{id}/grants": {
        parameters: [PLAN_ID_PARAM],
        post: GRANT_PLAN_OPERATION,
      },
      "/api/plans/{id}/grants/{handle}": {
        parameters: [PLAN_ID_PARAM, HANDLE_PATH_PARAM],
        delete: REVOKE_GRANT_OPERATION,
      },
      "/api/plans/{id}/unlock": {
        parameters: [PLAN_ID_PARAM],
        post: UNLOCK_PLAN_OPERATION,
      },
      "/p/{id}": DOCUMENT_PATH,
      "/healthz": HEALTH_PATH,
    },
    components: {
      schemas: componentSchemas(config.shareCodeLength),
      securitySchemes: SECURITY_SCHEMES,
    },
  };
}
