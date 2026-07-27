# Self-hosting BunkerPlan

BunkerPlan runs from one source tree on two targets:

- **Cloudflare Workers** - R2 (objects), D1 (database and rate-limit counters),
  Workers KV (session cache). Built with `bun run build`.
- **Bun** - any S3-compatible store, Postgres or SQLite, Valkey. Built with
  `bun run build` and shipped in the provided `Dockerfile`, which carries a
  single bundled `dist/server/index.js` plus the client assets - no source tree
  and no `node_modules`.

Every backing service is selected at runtime, so the same image serves both.

## Quick start with Docker Compose

The provided stack exercises all three swaps at once (Postgres + Valkey +
MinIO):

```sh
git clone https://github.com/bunkerlab-net/bunkerplan.git && cd bunkerplan
cp .env.example .env      # set BETTER_AUTH_SECRET
docker compose up --build -d
curl -s localhost:3000/healthz
# {"status":"ok","checks":{"storage":"ok","db":"ok","kv":"ok"}}
```

## Deploying to Cloudflare

`wrangler.jsonc` ships with placeholder resource ids so `bun run dev` works
with no setup. Provision the real resources once, then replace them:

```sh
wrangler d1 create bunkerplan            # copy database_id into wrangler.jsonc
wrangler kv namespace create KV          # copy id into wrangler.jsonc
wrangler r2 bucket create bunkerplan

# Set vars.PUBLIC_BASE_URL in wrangler.jsonc to the real origin.
# It MUST match the browser origin exactly or WebAuthn rejects every ceremony.

wrangler secret put BETTER_AUTH_SECRET   # never a var - secrets only
bun run cf-typegen                       # regenerate the Env types
wrangler d1 migrations apply bunkerplan --remote
bun run deploy
```

`bun run deploy` refuses to run while any placeholder is still in place, so a
production deploy cannot silently ship the localhost WebAuthn origin.

## Environment contract

These names are the API. They are not renamed across releases.

| Var                      | Required        | Default                       | Notes                                                                    |
| ------------------------ | --------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`     | yes             | -                             | rejected if under 32 characters                                          |
| `PUBLIC_BASE_URL`        | yes             | -                             | e.g. `https://plans.example.com`; also used as the Better Auth base URL  |
| `RP_ID`                  | no              | hostname of `PUBLIC_BASE_URL` | WebAuthn relying-party id; must equal that hostname or be a parent of it |
| `RP_NAME`                | no              | `BunkerPlan`                  | shown in the passkey prompt                                              |
| `CLIENT_IP_HEADER`       | **off Workers** | `cf-connecting-ip` on Workers | single header your proxy **overwrites** with the client IP               |
| `MAX_UPLOAD_BYTES`       | no              | `2097152` (2 MiB)             |                                                                          |
| `MAX_PLANS_PER_USER`     | no              | `250`                         | stored plans per account; bounds total storage with `MAX_UPLOAD_BYTES`   |
| `UPLOAD_RATE_MAX`        | no              | `30`                          | writes per window per user                                               |
| `UPLOAD_RATE_WINDOW_SEC` | no              | `60`                          | clamped to a minimum of 60                                               |
| `PLAN_ID_LENGTH`         | no              | `16`                          | characters in a plan id; lowercase alphanumeric, 8 to 63                 |
| `SHARE_CODE_LENGTH`      | no              | `16`                          | characters in a share code; mixed-case alphanumeric, 16 to 64            |
| `LOG_FORMAT`             | no              | `json`                        | `json` (ECS) \| `plain` (pino-pretty)                                    |
| `LOG_LEVEL`              | no              | `info`                        | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` \| `silent` |
| `LOG_COLOR`              | no              | `false`                       | colourises `LOG_FORMAT=plain` only                                       |
| `STORAGE_DRIVER`         | no on Workers   | `r2` on Workers               | `r2` \| `s3`                                                             |
| `S3_ENDPOINT`            | no              | -                             | **omit for real AWS S3**; set for MinIO / R2 / GCS                       |
| `S3_BUCKET`              | if `s3`         | -                             |                                                                          |
| `S3_ACCESS_KEY_ID`       | no              | -                             | **omit on AWS** - see below                                              |
| `S3_SECRET_ACCESS_KEY`   | no              | -                             | must be set together with the key id                                     |
| `S3_REGION`              | no              | `us-east-1`                   | use `auto` for R2                                                        |
| `S3_FORCE_PATH_STYLE`    | no              | `true`                        | set `false` for real AWS S3                                              |
| `DB_DRIVER`              | no on Workers   | `d1` on Workers               | `d1` \| `sqlite` \| `postgres`                                           |
| `SQLITE_PATH`            | if `sqlite`     | `./data/bunkerplan.db`        |                                                                          |
| `DATABASE_URL`           | if `postgres`   | -                             |                                                                          |
| `KV_DRIVER`              | no on Workers   | `kv` on Workers               | `kv` \| `valkey`                                                         |
| `VALKEY_URL`             | if `valkey`     | -                             | e.g. `redis://valkey:6379`                                               |

A misconfigured deployment fails at boot with every problem listed at once, not
on the first request.

## Swap matrices

| Role                   | Cloudflare                                | Self-hosted                                      |
| ---------------------- | ----------------------------------------- | ------------------------------------------------ |
| Objects                | R2 binding `BUCKET` (`STORAGE_DRIVER=r2`) | any S3-compatible store (`STORAGE_DRIVER=s3`)    |
| Database + rate limits | D1 binding `DB` (`DB_DRIVER=d1`)          | Postgres (`postgres`) or local SQLite (`sqlite`) |
| Session cache          | KV binding `KV` (`KV_DRIVER=kv`)          | Valkey/Redis (`KV_DRIVER=valkey`)                |

`d1`, `r2`, and `kv` are Workers-only; `sqlite`, `postgres`, `s3`, and `valkey`
are self-hosted-only. Choosing a driver that does not exist on the current
runtime fails at boot with an explicit message.

## Migrations

| Target      | Command                                            |
| ----------- | -------------------------------------------------- |
| D1 (local)  | `wrangler d1 migrations apply bunkerplan --local`  |
| D1 (remote) | `wrangler d1 migrations apply bunkerplan --remote` |
| SQLite      | `bun run db:migrate:sqlite`                        |
| Postgres    | `bun run db:migrate:pg`                            |

Migration SQL is generated from the Drizzle schemas with `bun run db:generate`.
The Compose stack runs the Postgres migration as a one-shot `migrate` service
before `app` starts.

## AWS credentials

**For AWS S3, leave `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and
`S3_ENDPOINT` unset** and attach an IAM role. The SDK then resolves credentials
through its standard chain - web identity (EKS IRSA), ECS/EKS task roles, EC2
instance profiles, SSO, shared config - and rotates them automatically.

```sh
# EC2 / ECS / EKS with an attached role - the correct AWS setup
STORAGE_DRIVER=s3
S3_BUCKET=my-plans
S3_REGION=eu-west-2
S3_FORCE_PATH_STYLE=false
```

Set static keys **only** for stores that have no credential chain:

```sh
# MinIO
STORAGE_DRIVER=s3
S3_BUCKET=bunkerplan
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...

# Cloudflare R2 over its S3 API (from outside Workers)
STORAGE_DRIVER=s3
S3_BUCKET=bunkerplan
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...

# Google Cloud Storage over its S3 interoperability API
STORAGE_DRIVER=s3
S3_BUCKET=bunkerplan
S3_ENDPOINT=https://storage.googleapis.com
S3_REGION=auto
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Setting exactly one of the two keys is a configuration error and is rejected at
boot - silently falling through to the provider chain would surface as a
confusing 403 much later.

## Operational warnings

- **`PUBLIC_BASE_URL` must match the browser origin exactly.** WebAuthn compares
  origins; a mismatch (including `http` vs `https`, or a stray port) fails the
  ceremony with an opaque browser error.
- **`RP_ID` cannot be changed later.** It must be the registrable domain.
  Changing it invalidates every registered passkey - every user is locked out.
  Startup refuses a value the `PUBLIC_BASE_URL` hostname is neither equal to
  nor a subdomain of, because no ceremony could succeed with one.
- **TLS is required for WebAuthn** on every origin except `localhost`.
- **`CLIENT_IP_HEADER` is required off Cloudflare, and startup fails without
  it.** There is no default worth guessing. Better Auth keys its auth rate
  limit on the client IP and records it on each session; name the one header
  your proxy _overwrites_ (commonly `x-real-ip`, or `x-forwarded-for` if the
  proxy replaces rather than appends to it).
  - A header a client can set itself lets that client forge a fresh bucket per
    request, which removes the limit entirely.
  - A header your proxy _appends_ to arrives as a chain, is refused as
    spoofable, and drops every caller into one shared bucket - so a single
    client can 429 every sign-in attempt in the deployment.
  - On Cloudflare the default `cf-connecting-ip` is correct, because the edge
    overwrites it.
- **The self-hosted server requires the Bun runtime.** `dist/server/index.js`
  is bundled with `bun build --target=bun`, and `DB_DRIVER=sqlite` needs
  `bun:sqlite` on top of that. The provided image runs Bun, so both hold there.
  Postgres is the recommended driver regardless: SQLite is single-node.
- **Rate limit counters live in the database, never in KV.** Workers KV
  throttles a single key to one write per second and takes up to 60s to
  propagate, which is the opposite of what a counter needs. Both limiters -
  Better Auth's per-IP one on `/api/auth/*` and the per-user upload one on
  `PUT /api/plans` - decide inside a single conditional SQL statement, so a
  concurrent burst cannot exceed the limit.
- **The upload limit is per user, not per credential.** An API key and the
  dashboard session draw on the same `UPLOAD_RATE_MAX` allowance, so creating
  more keys does not buy more uploads. The api-key plugin's own per-key limiter
  is deliberately disabled: it only runs when a key is verified, so it would
  miss dashboard uploads entirely.
- **KV propagation is up to 60 seconds across regions.** A revoked session can
  linger in another region until the database fallback catches it. Sessions are
  stored in the database as well as KV precisely so a KV miss degrades to a
  database read rather than logging the user out.
- **Do not remove the `Content-Security-Policy: sandbox` header on `/p/{id}`.**
  Plans are untrusted HTML served from the same origin as the session cookie.
  Without the sandbox, a plan's inline script could issue credentialed
  same-origin requests to `/api/*` and take over the uploader's account.
- **Security headers are applied in `src/server.ts`**, the one entry both
  targets share: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options:
DENY`, HSTS over TLS, and a CSP limited to `base-uri`, `object-src`,
  `form-action`, and `frame-ancestors`. Each is only set when absent, so the
  plan route's `sandbox` CSP above always wins. The app CSP deliberately has no
  `script-src`: server-side rendering inlines the hydration payload, so a
  script policy needs per-request nonces, and `'unsafe-inline'` would be
  theatre. Helmet is not used - it is Express middleware and cannot run on
  Workers.
- **Account deletion is immediate and irreversible.** There is no email
  confirmation because addresses are synthetic (`…@passkey.invalid`) and cannot
  receive mail. The safeguards are Better Auth's fresh-session requirement
  (re-prompting for the passkey) and a type-the-handle confirmation in the UI.

## API

Every endpoint below is described at `/api/docs`, a Scalar reference rendered
from `/api/openapi.json`. The document is generated from the same schemas the
handlers answer with, and `servers` and the upload cap come from the running
deployment's own configuration - so a self-hosted instance publishes its
limits, not this repository's defaults. Both pages are unauthenticated, and
neither loads anything off-origin.

Authentication is an API key in the `x-api-key` header. Keys are minted from
the dashboard; there is no limit on how many, and expiry is optional. A key
authorises upload, replacement, delete, and reading any plan its owner may
read. Listing plans, relabelling them, every sharing route, managing keys, and
deleting the account all require a session - a leaked key must not be able to
hand out access to other people.

A plan is private unless its upload said otherwise. `?visibility=` takes
`public`, `private` (the default), or `code`; `code` stores the plan private
and mints a share code, returned once in the 201 body and never readable
afterwards. An unauthorised visitor to a private plan gets `401` and a gate
page offering a code box and a sign-in button.

```sh
# Upload, optionally labelled
curl -X PUT "https://plans.example.com/api/plans?label=Q3%20rollout" \
  -H "x-api-key: bkp_..." \
  -H "content-type: text/html" \
  --data-binary @plan.html
# 201 {"id":"...","url":"https://plans.example.com/p/...","label":"Q3 rollout"}

# Publish, or mint a share link in the same request
curl -X PUT "https://plans.example.com/api/plans?visibility=code" \
  -H "x-api-key: bkp_..." \
  -H "content-type: text/html" \
  --data-binary @plan.html
# 201 {"id":"...","url":"...","label":null,"code":"9wRaReOwG14Cw0ko"}
# Share ${url}?code=${code} - the code is never returned again.

# Replace the document behind an id you own - same URL, same label
curl -X PUT https://plans.example.com/api/plans/<id> \
  -H "x-api-key: bkp_..." \
  -H "content-type: text/html" \
  --data-binary @plan.html
# 200 {"id":"...","url":"https://plans.example.com/p/..."}

# Delete
curl -X DELETE https://plans.example.com/api/plans/<id> -H "x-api-key: bkp_..."
# 204
```

A label is owner-facing only. It is stored on the plan row, shown in the
dashboard, and returned by `GET /api/plans`; it never reaches the object store
and never appears in the public URL, so relabelling changes nothing a visitor
can see. Labels are free text up to 100 characters, are not unique, and are
optional - the id stays the identity. Blank clears the label. The dashboard
edits them in place with `PATCH /api/plans/<id>` and a `{"label":"..."}` body,
which is session-only.

Replacing draws on the same per-user upload allowance as a new upload, and is
scoped to the caller: an id owned by another account is a `404`, and its object
is never touched. Everything but the bytes survives - the id, the public URL,
the label, and the creation timestamp. Plans are served with
`Cache-Control: public, max-age=300, must-revalidate`, so a cache that already
holds the old document can keep serving it for up to five minutes.

Uploads must be **standalone** HTML: no external scripts, stylesheets, images,
fonts, iframes, or CSS `url()`/`@import` targets - including relative paths,
which have nothing to resolve against. A non-empty `iframe[srcdoc]` is rejected
outright: it carries a whole nested document, and its value is entity-encoded,
so validating it would mean trusting a hand-rolled entity decoder as a security
boundary. Inline `<style>`, inline `<script>`,
`data:` URIs and ordinary `<a href>` links are all fine. A rejection returns
`422` with the offending `tag[attribute]` in the body.

Note that this is a static check. A plan's inline script can still call `fetch`
at runtime; the CSP sandbox is what contains it.

Plans are served from `GET /p/{id}`, and `/p/` is reserved for them alone.
Routing anything else under that prefix would out-rank the plan route and
silently shadow any plan holding that id, which is exactly the collision the
prefix exists to prevent. App routes go anywhere else; because they do, plan
ids need no reserved-word list.

## Health

`GET /healthz` probes storage, the database, and KV concurrently. It returns
`200` with every check `"ok"`, or `503` naming the failed checks. The underlying
exception never reaches the response body, because a driver error can embed the
connection string and `/healthz` is unauthenticated. It is logged instead, where
an operator can act on it.

The probe is self-hosted only: on Cloudflare it returns `404`. Nothing there
polls it - the platform reports Worker health - and because the route is
unauthenticated, each call would turn one public request into three billable
backend operations (a D1 query, a KV read, an R2 head), which anyone holding the
URL could aim at your bill. On Workers the refusal is returned before any
binding is touched.

Note the limit of that fix: the Worker request itself is still billed, exactly
as it is for any other path. Removing that cost too means a rate-limiting or
WAF rule in front of the Worker, which lives in Cloudflare's own configuration
rather than in this repo.

Logs are sanitised on the way out. Every line passes through two filters before
it leaves the process:

- pino's `redact` censors values at known credential key paths (`password`,
  `secret`, `apiKey`, `authorization`, `connectionString`, `accessKeyId`,
  `secretAccessKey`, and the same names one level deep).
- Connection-URL userinfo is stripped from the serialised line, which `redact`
  cannot reach: a failing `pg` or `ioredis` driver puts the whole URL inside
  `error.message`, where no key path points at it.

The second filter removes the username as well as the password. A password may
contain `:` and, when a driver echoes unencoded input, `@`, so the boundary
between them cannot be located reliably; censoring the whole userinfo is the
only version with no parse ambiguity left to leak through. Host and port
survive, so a connection failure is still diagnosable:

```
postgres://app:hunter2@db.internal:5432/plans
postgres://[redacted]@db.internal:5432/plans
```

Sanitising happens in the log destination rather than at each call site, so a
log statement added later cannot forget it.
