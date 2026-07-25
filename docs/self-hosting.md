# Self-hosting BunkerPlan

BunkerPlan runs from one source tree on two targets:

- **Cloudflare Workers** — R2 (objects), D1 (database), Workers KV (session
  cache and rate limits). Built with `bun run build`.
- **Node/Bun** — any S3-compatible store, Postgres or SQLite, Valkey. Built with
  `bun run build:node` and shipped in the provided `Dockerfile`.

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

wrangler secret put BETTER_AUTH_SECRET   # never a var — secrets only
bun run cf-typegen                       # regenerate the Env types
wrangler d1 migrations apply bunkerplan --remote
bun run deploy
```

`bun run deploy` refuses to run while any placeholder is still in place, so a
production deploy cannot silently ship the localhost WebAuthn origin.

## Environment contract

These names are the API. They are not renamed across releases.

| Var | Required | Default | Notes |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | yes | — | rejected if under 32 characters |
| `PUBLIC_BASE_URL` | yes | — | e.g. `https://plans.example.com`; also used as the Better Auth base URL |
| `RP_ID` | no | hostname of `PUBLIC_BASE_URL` | WebAuthn relying-party id |
| `RP_NAME` | no | `BunkerPlan` | shown in the passkey prompt |
| `MAX_UPLOAD_BYTES` | no | `2097152` (2 MiB) | |
| `UPLOAD_RATE_MAX` | no | `30` | writes per window per user |
| `UPLOAD_RATE_WINDOW_SEC` | no | `60` | clamped to a minimum of 60 |
| `PLAN_ID_LENGTH` | no | `16` | characters in a plan id; alphanumeric only, minimum 8 |
| `LOG_FORMAT` | no | `json` | `json` (ECS) \| `plain` (pino-pretty) |
| `LOG_LEVEL` | no | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` \| `silent` |
| `LOG_COLOR` | no | `false` | colourises `LOG_FORMAT=plain` only |
| `STORAGE_DRIVER` | no on Workers | `r2` on Workers | `r2` \| `s3` |
| `S3_ENDPOINT` | no | — | **omit for real AWS S3**; set for MinIO / R2 / GCS |
| `S3_BUCKET` | if `s3` | — | |
| `S3_ACCESS_KEY_ID` | no | — | **omit on AWS** — see below |
| `S3_SECRET_ACCESS_KEY` | no | — | must be set together with the key id |
| `S3_REGION` | no | `us-east-1` | use `auto` for R2 |
| `S3_FORCE_PATH_STYLE` | no | `true` | set `false` for real AWS S3 |
| `DB_DRIVER` | no on Workers | `d1` on Workers | `d1` \| `sqlite` \| `postgres` |
| `SQLITE_PATH` | if `sqlite` | `./data/bunkerplan.db` | |
| `DATABASE_URL` | if `postgres` | — | |
| `KV_DRIVER` | no on Workers | `kv` on Workers | `kv` \| `valkey` |
| `VALKEY_URL` | if `valkey` | — | e.g. `redis://valkey:6379` |

A misconfigured deployment fails at boot with every problem listed at once, not
on the first request.

## Swap matrices

| Role | Cloudflare | Self-hosted |
|---|---|---|
| Objects | R2 binding `BUCKET` (`STORAGE_DRIVER=r2`) | any S3-compatible store (`STORAGE_DRIVER=s3`) |
| Database | D1 binding `DB` (`DB_DRIVER=d1`) | Postgres (`postgres`) or local SQLite (`sqlite`) |
| Session cache + rate limits | KV binding `KV` (`KV_DRIVER=kv`) | Valkey/Redis (`KV_DRIVER=valkey`) |

`d1`, `r2` and `kv` are Workers-only; `sqlite`, `postgres`, `s3` and `valkey`
are Node/Bun-only. Choosing a driver that does not exist on the current runtime
fails at boot with an explicit message.

## Migrations

| Target | Command |
|---|---|
| D1 (local) | `wrangler d1 migrations apply bunkerplan --local` |
| D1 (remote) | `wrangler d1 migrations apply bunkerplan --remote` |
| SQLite | `bun run db:migrate:sqlite` |
| Postgres | `bun run db:migrate:pg` |

Migration SQL is generated from the Drizzle schemas with `bun run db:generate`.
The Compose stack runs the Postgres migration as a one-shot `migrate` service
before `app` starts.

## AWS credentials

**For AWS S3, leave `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and
`S3_ENDPOINT` unset** and attach an IAM role. The SDK then resolves credentials
through its standard chain — web identity (EKS IRSA), ECS/EKS task roles, EC2
instance profiles, SSO, shared config — and rotates them automatically.

```sh
# EC2 / ECS / EKS with an attached role — the correct AWS setup
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
boot — silently falling through to the provider chain would surface as a
confusing 403 much later.

## Operational warnings

- **`PUBLIC_BASE_URL` must match the browser origin exactly.** WebAuthn compares
  origins; a mismatch (including `http` vs `https`, or a stray port) fails the
  ceremony with an opaque browser error.
- **`RP_ID` cannot be changed later.** It must be the registrable domain.
  Changing it invalidates every registered passkey — every user is locked out.
- **TLS is required for WebAuthn** on every origin except `localhost`.
- **`DB_DRIVER=sqlite` requires the Bun runtime** (`bun:sqlite`). The provided
  image runs Bun, so it works there. Running the Nitro output under plain Node
  means using `postgres`. Postgres is the recommended self-hosted driver
  regardless: SQLite is single-node.
- **The upload rate-limit counter is best-effort on Workers KV.** KV has no
  atomic increment and concurrent writes to one key are last-write-wins, so a
  client can exceed the limit under concurrency. Valkey deployments count
  exactly via `INCR`.
- **KV propagation is up to 60 seconds across regions.** A revoked session can
  linger in another region until the database fallback catches it. Sessions are
  stored in the database as well as KV precisely so a KV miss degrades to a
  database read rather than logging the user out.
- **Do not remove the `Content-Security-Policy: sandbox` header on `/{id}`.**
  Plans are untrusted HTML served from the same origin as the session cookie.
  Without the sandbox, a plan's inline script could issue credentialed
  same-origin requests to `/api/*` and take over the uploader's account.
- **Security headers are applied in `src/server.ts`**, the one entry both
  targets share: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options:
  DENY`, HSTS over TLS, and a CSP limited to `base-uri`, `object-src`,
  `form-action` and `frame-ancestors`. Each is only set when absent, so the
  plan route's `sandbox` CSP above always wins. The app CSP deliberately has no
  `script-src`: server-side rendering inlines the hydration payload, so a
  script policy needs per-request nonces, and `'unsafe-inline'` would be
  theatre. Helmet is not used — it is Express middleware and cannot run on
  Workers.
- **Account deletion is immediate and irreversible.** There is no email
  confirmation because addresses are synthetic (`…@passkey.invalid`) and cannot
  receive mail. The safeguards are Better Auth's fresh-session requirement
  (re-prompting for the passkey) and a type-the-handle confirmation in the UI.

## API

Authentication for writes is an API key in the `x-api-key` header. Keys are
minted from the dashboard; there is no limit on how many, and expiry is
optional. A key authorises upload and delete for its owner's plans and nothing
else — listing plans, managing keys and deleting the account all require a
session.

```sh
# Upload
curl -X PUT https://plans.example.com/api/plans \
  -H "x-api-key: bkp_..." \
  -H "content-type: text/html" \
  --data-binary @plan.html
# 201 {"id":"...","url":"https://plans.example.com/..."}

# Delete
curl -X DELETE https://plans.example.com/api/plans/<id> -H "x-api-key: bkp_..."
# 204
```

Uploads must be **standalone** HTML: no external scripts, stylesheets, images,
fonts, iframes or CSS `url()`/`@import` targets — including relative paths,
which have nothing to resolve against. A non-empty `iframe[srcdoc]` is rejected
outright: it carries a whole nested document, and its value is entity-encoded,
so validating it would mean trusting a hand-rolled entity decoder as a security
boundary. Inline `<style>`, inline `<script>`,
`data:` URIs and ordinary `<a href>` links are all fine. A rejection returns
`422` with the offending `tag[attribute]` in the body.

Note that this is a static check. A plan's inline script can still call `fetch`
at runtime; the CSP sandbox is what contains it.

## Health

`GET /healthz` probes storage, the database and KV concurrently. It returns
`200` with every check `"ok"`, or `503` naming the failed checks. The underlying
exception never reaches the response body, because a driver error can embed the
connection string and `/healthz` is unauthenticated. It is logged instead, where
an operator can act on it.

The probe is self-hosted only: on Cloudflare it returns `404`. Nothing there
polls it — the platform reports Worker health — and because the route is
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
