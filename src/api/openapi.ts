/**
 * The published OpenAPI 3.1 document, assembled from the Zod schemas in
 * src/api/schemas.ts rather than maintained beside them.
 *
 * Scoped to what an API key can call - upload, replace, rename, list, delete,
 * and read - together with the operations that need no key at all: reading a
 * public plan or one whose share code or unlock cookie opens the gate,
 * redeeming such a code, and the health probe. What is deliberately absent is
 * the sharing *management* set: visibility, share codes, and grants. Those are
 * session-only, they exist for the dashboard, which calls them from
 * src/client/api.ts with the types in src/api/schemas.ts, and a reference that
 * describes them documents a browser session to a reader who is holding a key
 * and cannot use one. `tests/openapi.test.ts` names each of them, so a new
 * session-only route still has to be classified rather than silently omitted.
 *
 * `/api/auth/*` is absent for a different reason. Better Auth owns every route
 * under that prefix and its surface changes with the plugin set, so describing
 * it by hand here is exactly the drift this module exists to avoid.
 */
import type { ZodType } from "zod";
import { type Config, MIN_SHARE_CODE_LENGTH } from "../config.ts";
import { MAX_GRANTS_PER_REQUEST } from "../http/account-list.ts";
import { MAX_PLAN_LABEL_LENGTH } from "../http/plan-label.ts";
import { MAX_LABEL_BODY_BYTES } from "../http/relabel-plan.ts";
import { SHARE_CODE_ALPHABET_LENGTH } from "../ids.ts";
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
  PlanVisibilityQuery,
  RelabelRequest,
  ref,
  ShareCodeQuery,
  shareCodeFormat,
  UnlockRequest,
} from "./schemas.ts";

export const API_TITLE = "BunkerPlan API";

/**
 * Not derived from anything: package.json carries no version, because the app
 * is private and deployed from a commit rather than published. It moves when
 * what this document publishes does, spelled as semver over the document
 * itself.
 *
 * 2.0.0 because a client regenerated from it loses six operations and the
 * `session` scheme, which is a removal however it is motivated. Nothing about
 * how those six answer changed - they still serve the dashboard - while the
 * additive half of the same change, `GET /api/plans` and
 * `PATCH /api/plans/{id}` beginning to accept a key, would have been a minor on
 * its own.
 */
const API_VERSION = "2.0.0";

const API_KEY_SCHEME = "apiKey";

/**
 * A key acts for its owner on every plan operation but sharing: upload,
 * replacement, relabelling, delete, listing, and reading a plan that owner may
 * read. See src/http/require-user.ts.
 *
 * The dashboard's session cookie authorises all of these too - `resolveUserId`
 * accepts either - and is not listed, because this document describes the key
 * surface and a `session` scheme here would invite a client to send a cookie it
 * has no way to obtain outside a browser.
 */
const KEY_AUTH = [{ [API_KEY_SCHEME]: [] }];
/**
 * A public plan needs no credential and a private one needs a key, a share
 * code, or an unlock cookie. The leading empty Security Requirement Object is
 * how OpenAPI 3.1 spells "optional here".
 */
const OPTIONAL_AUTH = [{}, { [API_KEY_SCHEME]: [] }];

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
  "Nothing identified a user: an `x-api-key` header that verifies to no " +
  "account, or no header and no dashboard session standing in for one. A key " +
  "that fails never falls back to a cookie.";
const NOT_FOUND =
  "No such plan, or it belongs to another account - the two are " +
  "indistinguishable on purpose, so an id can never be confirmed to exist.";
const UNSUPPORTED_MEDIA = "`content-type` was not `text/html`.";
const NOT_STANDALONE =
  "The document loads something external. Up to ten of the references " +
  "objected to are listed, so one upload is usually enough to learn all of " +
  "them: `error` is the first, `errors` holds them all when there was more " +
  "than one, and `truncated` is present when the cap dropped others. Each " +
  "target is cut to its first 120 characters, followed by an ellipsis when it " +
  "was longer. Webfonts count: they have to travel as `data:` URIs in " +
  "`@font-face`, which costs about 65 KB for a latin subset rather than the " +
  "megabytes it is usually assumed to.\n\n" +
  "Two refusals name markup rather than a reference. A `<style>` inside " +
  "`<svg>` holds a stylesheet built from its direct text, so once another " +
  "element opens inside it - or an end tag appears that may be closing an " +
  "ancestor - where the rest of that text belongs depends on HTML tree " +
  "construction. Keep such a stylesheet to text, `<![CDATA[ ... ]]>` " +
  "included, and it is read exactly.\n\n" +
  "The other names nesting. A self-closing `<svg/>` or `<math/>`, or foreign " +
  "end tags that cross as in `<svg><math></svg>`, leave the parse describing " +
  "something a browser is not reading, after which no verdict is given. Close " +
  "each one with its own end tag, in order, and the document is read normally.";
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

const GRANTS_QUERY_PARAM = {
  name: "grants",
  in: "query",
  required: false,
  description:
    "Accounts to share the new plan with, comma-separated. Names them in " +
    "the same request that stores the plan, so a private plan need never " +
    "exist unshared. Each entry is a handle or an account id, and at most " +
    `${MAX_GRANTS_PER_REQUEST} of them. The 201 reports which ones landed.`,
  schema: { type: "string", examples: ["k7mjq2rvxn,q5qkesmr5v"] },
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
    security: KEY_AUTH,
    description:
      "`?visibility=code` stores the plan private and mints a share code, " +
      `returned once as \`code\` in the response body (${codeFormat}) ` +
      "and never readable afterwards.\n\n" +
      "For a link a person will open, put the code in the fragment of `/s/" +
      "{id}` - the same id as in `url` - giving " +
      "`https://host/s/{id}#code=CODE`. A fragment is never sent to a server, " +
      "so the code stays out of request lines, access logs and every " +
      "`Referer`. The code itself does reach this server when it is redeemed: " +
      "`/s/{id}` is this app's own " +
      "page, and it spends the code in the body of `POST /api/plans/{id}/" +
      "unlock` before sending the reader to the plan - so a proxy that logs " +
      "request bodies still sees it. It is deliberately not `url`: " +
      "`/p/{id}` answers a reader who already has access with the uploaded " +
      "document, and that document can read its own `location.hash`.\n\n" +
      "For a reader without a browser, append `?code=` to `url` instead - a " +
      "fragment cannot be sent by one - or redeem the code through " +
      "`POST /api/plans/{id}/unlock` and keep the cookie.",
    parameters: [LABEL_QUERY_PARAM, VISIBILITY_QUERY_PARAM, GRANTS_QUERY_PARAM],
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
    security: KEY_AUTH,
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

const DELETE_PLAN_OPERATION = {
  operationId: "deletePlan",
  summary: "Delete a plan",
  description: "The id is never reissued.",
  tags: ["Plans"],
  security: KEY_AUTH,
  responses: {
    "204": { description: "The plan is gone. No body." },
    ...failures({ 401: UNAUTHORISED, 404: NOT_FOUND, 502: STORAGE_DOWN }),
  },
};

const LIST_PLANS_OPERATION = {
  operationId: "listPlans",
  summary: "List your plans",
  description:
    `Returns at most ${PLAN_PAGE_SIZE} plans, newest first. A key sees its ` +
    "owner's plans, which are the ones it could already read, replace, and " +
    "delete one id at a time.",
  tags: ["Plans"],
  security: KEY_AUTH,
  responses: {
    "200": json(PlanList, "The caller's plans."),
    ...failures({ 401: UNAUTHORISED }),
  },
};

const RELABEL_PLAN_OPERATION = {
  operationId: "relabelPlan",
  summary: "Rename a plan",
  description:
    "Nothing outside the row changes - the object key, the public URL, and " +
    "the served document are all untouched. `?label=` on upload names a plan " +
    "without a second request.",
  tags: ["Plans"],
  security: KEY_AUTH,
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

/**
 * Bits in the shortest code this deployment will still redeem.
 *
 * Derived from `MIN_SHARE_CODE_LENGTH`, not from `SHARE_CODE_LENGTH`: what the
 * document should publish is the weakest code that can still be presented, and
 * lowering the mint length does not retire codes issued under the old one. The
 * alphabet's length comes from src/ids.ts, which owns it, so neither raising
 * the floor nor changing the alphabet can leave a stale number here.
 */
const MIN_CODE_BITS = Math.round(
  MIN_SHARE_CODE_LENGTH * Math.log2(SHARE_CODE_ALPHABET_LENGTH),
);

/** Lifted out so `unlockPlanOperation` stays a shape rather than an essay. */
const unlockDescription = (codeFormat: string): string =>
  "Unauthenticated: this is what the gate page calls. A correct code " +
  "sets a path-scoped, HttpOnly cookie for this one plan, after which " +
  "`/p/{id}` serves it with no parameter and no session. " +
  `${codeFormat} Throttled per client address, set by UNLOCK_RATE_MAX ` +
  "and UNLOCK_RATE_WINDOW_SEC.\n\n" +
  "A redemption gets its count back, and so does a `500` - neither spent a " +
  "guess, and a failure disclosed nothing about the code. Returning it is " +
  "best-effort: if that fails the count stays spent, which errs towards " +
  "refusing. Every refusal keeps its count: a wrong code, an unknown plan, " +
  "a body this endpoint cannot read. " +
  "A correct code costs nothing, " +
  "because a share link is opened by everyone it was sent to and charging " +
  "those would refuse a room of colleagues behind one egress address. What " +
  "is rationed is guessing, and the budget bounds that rather than deciding " +
  `it: the shortest redeemable code carries about ${MIN_CODE_BITS} bits, ` +
  "which no reachable rate would improve on. The bucket is the address " +
  "rather than the plan, because the plan id is in the share link and a " +
  "per-plan bucket would let anyone holding it lock the other readers out.";

function unlockPlanOperation(codeFormat: string): Record<string, unknown> {
  return {
    operationId: "unlockPlan",
    summary: "Redeem a share code",
    description: unlockDescription(codeFormat),
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
        400:
          "The body is not JSON, or `code` is missing, not a string, or " +
          "empty. One status for all three: the gate page is the only caller " +
          "and they mean the same thing to it.",
        401: "The code did not match.",
        404: "No such plan, or it has no share code - the two are indistinguishable on purpose.",
        413: "The body is larger than a code could make it.",
      }),
      // Spelled out rather than through `failures`, which documents the
      // JSON `ErrorBody` every *returned* refusal carries. This one is thrown -
      // the route has no handler of its own and the app installs no
      // `onError` - so what reaches the client is Hono's default, which is
      // plain text. Documenting it as JSON would be a wire contract nothing
      // honours.
      "500": {
        description:
          "The redemption could not be completed. Releasing its reservation " +
          "is attempted, because a failure said nothing about the code - and " +
          "if that release fails too, the count stays spent.",
        content: { "text/plain": { schema: { type: "string" } } },
      },
      "429": {
        ...json(
          ErrorBody,
          "Too many redemptions from this address. `retry-after` says for " +
            "how long. The bucket is the client address, so one address " +
            "cannot spend another address's allowance - but callers sharing " +
            "an address, behind one office NAT or mobile gateway, share the " +
            "allowance too.",
        ),
        headers: {
          "retry-after": {
            description: "Seconds until the allowance refills.",
            schema: { type: "integer", minimum: 0 },
          },
        },
      },
    },
  };
}

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
              "but must revalidate on every read; `private, no-store` for a " +
              "private one.",
            schema: { type: "string" },
          },
          vary: {
            description:
              "`cookie, x-api-key` on a private plan, whose response turns " +
              "on which credential opened the gate. Absent on a public one, " +
              "which is the same for everyone. Declared here rather than " +
              "only described, so a generated client sees it.",
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
    "An API key authorises upload, replacement, relabelling, delete, listing",
    "the account's plans, and reading any plan its owner may read. Two",
    "operations here need no key at all: redeeming a share code, and the health",
    "probe. Reading a plan takes one only when the plan is private and nothing",
    "else opens the gate.",
    "",
    "Managing who else may read a plan - visibility, share codes, grants - is",
    "session-only, so it is not described here: a key cannot call it. A key can",
    "still publish or share a plan as it uploads it, through `?visibility=` and",
    "`?grants=`; what it cannot do is widen a plan that already exists. The",
    "dashboard does that.",
    "",
    "Registration, sign-in, and minting the key these operations expect all",
    "live under `/api/auth/*` and the dashboard it backs, which Better Auth",
    "owns and which is not described here.",
  ].join("\n"),
  license: { name: "MIT" },
};

const TAGS = [
  { name: "Plans", description: "Managing your own plans." },
  { name: "Sharing", description: "Redeeming a share code." },
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
      "replacement, relabelling, delete, listing, and reading any plan that " +
      "owner may read. It cannot change who else may read one.",
  },
};

const REF_PREFIX = "#/components/schemas/";

/**
 * Every `#/components/schemas/` name a value points at, at any depth.
 *
 * Anything else shaped like a `$ref` is passed over rather than refused. This
 * document points at component schemas and nothing else - `ref()` is the only
 * thing that writes one, and `tests/openapi.test.ts` fails a `$ref` that is not
 * a component schema or does not resolve - so policing it a second time here
 * would only add a way for `GET /api/openapi.json` to answer 500 where the
 * suite already answers red.
 */
function collectRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      if (child.startsWith(REF_PREFIX))
        into.add(child.slice(REF_PREFIX.length));
      continue;
    }
    collectRefs(child, into);
  }
}

/**
 * The components the paths actually reach, transitively.
 *
 * `componentSchemas` emits every registered schema, including the response
 * shapes of the session-only routes this document does not describe - and a
 * rendered reference lists components whether or not an operation names one, so
 * publishing all of them would put `PlanSharing` and friends in front of a
 * reader who has just been told those routes are elsewhere. Reachability is
 * computed rather than listed, so the set follows the paths above instead of
 * needing to be kept in step with them.
 *
 * A name nothing emitted is left out rather than thrown on: `ref()` already
 * refuses an unregistered schema at module load, and `tests/openapi.test.ts`
 * fails a `$ref` that resolves to no component.
 */
function publishedSchemas(
  paths: Record<string, PathItem>,
  schemas: Record<string, JsonSchema>,
): Record<string, JsonSchema> {
  const reached = new Set<string>();
  collectRefs(paths, reached);
  // Grows while it is walked: a component may `$ref` another one.
  for (const name of reached) collectRefs(schemas[name], reached);

  return Object.fromEntries(
    Object.entries(schemas).filter(([name]) => reached.has(name)),
  );
}

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

  const paths: Record<string, PathItem> = {
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
    "/api/plans/{id}/unlock": {
      parameters: [PLAN_ID_PARAM],
      post: unlockPlanOperation(codeFormat),
    },
    "/p/{id}": DOCUMENT_PATH,
    "/healthz": HEALTH_PATH,
  };

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: INFO,
    servers: [{ url: config.publicBaseUrl, description: "This deployment." }],
    tags: TAGS,
    paths,
    components: {
      schemas: publishedSchemas(
        paths,
        componentSchemas(config.shareCodeLength),
      ),
      securitySchemes: SECURITY_SCHEMES,
    },
  };
}
