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
| `UNLOCK_RATE_MAX`        | no              | `30`                          | share-code redemptions per window per client address                     |
| `UNLOCK_RATE_WINDOW_SEC` | no              | `60`                          | no minimum; a database row, so no KV TTL floor applies                   |
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
  propagate, which is the opposite of what a counter needs. All three limiters -
  Better Auth's per-IP one on `/api/auth/*`, the per-user upload one on
  `PUT /api/plans`, and the per-address unlock one on
  `POST /api/plans/{id}/unlock` - decide inside a single conditional SQL
  statement, so a concurrent burst cannot exceed the limit.
- **The unlock limit is keyed on the client address, never on the plan.**
  Redeeming a share code is the only route that takes no credential, so it is
  the only one whose bucket cannot be an account. It must not be the plan
  either: the plan id travels in the share link, so a per-plan bucket would let
  anyone holding that link spend the allowance and lock the other readers out.
  Because an address has no row to cascade from, `unlock_rate_limit` prunes its
  own closed windows on each redemption rather than relying on a foreign key.
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
- **A visibility flip does not retire a share code.** Making a plan public
  changes who may read it and nothing else: the digest stays, and the unlock
  cookies signed over it are not invalidated by the change. So an owner who
  opens a plan up for a week and closes it again has not destroyed the link they
  already handed out. Nothing is armed in the meantime that was not already
  reachable - a public plan is served to anyone holding its URL, and access is
  granted on `visibility` before the hash is read, so a retained code gates
  nothing while public. Retiring a code is
  `POST /api/plans/{id}/share-code`, which replaces it, or `DELETE`, which drops
  it; both invalidate every unlock cookie issued under the old digest, and
  `DELETE` works whatever the plan's visibility. A public plan still cannot be
  given a *new* code (409), because a new one would gate nothing. Grants behave
  the same way: they name accounts the owner chose, and each is revocable on its
  own.
- **Security headers are applied in `src/http/security-headers.ts`**, reached
  from the one middleware both targets share: `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options: DENY`, HSTS over TLS, and `APP_CSP`.
  That policy is `default-src 'self'` with `script-src 'self'`,
  `img-src 'self'`, `connect-src 'self'`, `style-src 'self' 'unsafe-inline'`,
  `base-uri 'none'`, `object-src 'none'`, `form-action 'self'` and
  `frame-ancestors 'none'`. All of them, `APP_CSP` included, are set only when
  absent, so a route that already chose a header keeps it. The exception is
  the plan route: a successful `/p/{id}` response - `200` or `304` - has its
  CSP *replaced* with `PLAN_CSP`, whatever it already carried. That overwrite
  is the point of the split: a `304` legitimately carries almost no headers,
  and backfilling would let it take the app policy instead, whose lack of
  `sandbox` reads as permission to script the real origin.

  `script-src 'self'` is why nothing in this app inlines a script: the
  hydration payload rides in a `<script type="application/json">` element,
  which executes nothing, and `/api/docs` loads its bootstrap from
  `public/api-docs.js` for the same reason. `style-src` keeps `'unsafe-inline'`
  because the pages carry inline `style` attributes. Helmet is not used - it is
  Express middleware and cannot run on Workers.
- **Account deletion is immediate and irreversible.** There is no email
  confirmation because addresses are synthetic (`…@passkey.invalid`) and cannot
  receive mail. Three safeguards stand in: Better Auth's session-freshness
  window, which is its default 24 hours here and re-prompts for the passkey
  only once a session is older than that - not on every deletion; a
  type-the-handle confirmation in the UI; and the `x-expected-account` header,
  which the request must carry and the server compares against the session
  that made it - see API below, and expect a script that omits it to be
  refused.

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
read. Listing plans, relabelling them, changing who a plan is shared with,
managing keys, and deleting the account all require a session - a leaked key
must not be able to hand out access to other people.

Deleting an account takes one more thing. `POST /api/auth/delete-user` refuses
unless the request carries `x-expected-account` naming the account id it means
to delete, and Better Auth compares that against the session the same request
authenticated before anything is removed. A caller that omits the header is
refused rather than defaulted to its own session: the check exists because a
client cannot compare the two itself without leaving a window in which the
session changes, and one a request can skip is one a client regression drops
silently. Both refusals - a missing header and one naming a different account
than the session - answer `400` with the error code `WRONG_ACCOUNT`, and
nothing is deleted in either case. The dashboard sends the header; a script
deleting its own account should send the id `/api/auth/get-session` hands back.

Two routes are deliberately unauthenticated, because they are how someone
holding only a share code gets in: `GET /p/{id}?code=...` and
`POST /api/plans/{id}/unlock`. Both authorise on the code itself. Redeeming a
code is not the same as managing sharing, which stays session-only.

A plan is private unless its upload said otherwise. `?visibility=` takes
`public`, `private` (the default), or `code`; `code` stores the plan private
and mints a share code, returned once in the 201 body and never readable
afterwards. An unauthorised visitor to a private plan gets `401` and a gate
page offering a code box and a sign-in button.

A private plan can be shared with named accounts in the same request that
stores it, using `?grants=` with a comma-separated list, so it need never
exist unshared. The same list can be given later to
`POST /api/plans/{id}/grants` as `accounts`, either comma-separated or as a
JSON array.

Each entry is a **handle** - the value shown beside `Sign out` on that
person's own dashboard - or an **account id**, which `/api/auth/get-session`
returns to the signed-in account. An exact id wins; the handle is only
consulted when no account carries that id, so a token cannot match two people
and grant both. Both routes report which entries landed and which no account
answers to; one mistyped entry does not refuse the rest. At most 50 accounts
per request. Sharing with accounts is session-only after upload - a key can
name accounts on a plan it is creating, but cannot hand out access to an
existing one.

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

# Share with a whole team while storing the plan
curl -X PUT "https://plans.example.com/api/plans?visibility=private&grants=k7mjq2rvxn,q5qkesmr5v" \
  -H "x-api-key: bkp_..." \
  -H "content-type: text/html" \
  --data-binary @plan.html
# 201 {"id":"...","url":"...","label":null,
#      "granted":["k7mjq2rvxn","q5qkesmr5v"],"unknown":[]}

# Or afterwards, with a session
curl -X POST https://plans.example.com/api/plans/<id>/grants \
  -H "cookie: ..." -H "content-type: application/json" \
  -d '{"accounts":"k7mjq2rvxn, q5qkesmr5v"}'
# 200 {"granted":["k7mjq2rvxn","q5qkesmr5v"],"unknown":[]}

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
the label, and the creation timestamp. A public plan is served with
`Cache-Control: public, no-cache`, so a cache may keep a copy but has to
revalidate it on every read; a replacement is therefore picked up at once
rather than after a freshness window. A private plan is `private, no-store`.

Uploads must be **standalone** HTML: no external scripts, stylesheets, images,
fonts, iframes, or CSS `url()`/`@import` targets - including relative paths,
which have nothing to resolve against. A non-empty `iframe[srcdoc]` is rejected
outright: it carries a whole nested document, and its value is entity-encoded,
so validating it would mean trusting a hand-rolled entity decoder as a security
boundary. Inline `<style>`, inline `<script>`, `data:` URIs and ordinary
`<a href>` links are all fine.

A `link` is judged by its `rel`. Values that reach the network are refused:
`stylesheet` (including `alternate stylesheet`), `icon`, `preload`, `prefetch`,
`modulepreload`, `manifest`, `prerender`, and also `preconnect` and
`dns-prefetch`, which display nothing but still open a connection or resolve a
third-party name. Values that reach nothing are accepted: `canonical`,
`alternate`, `license`, `prev`, `next`, `me`. An unrecognised
`rel`, or a `link` with none at all, is refused - the allowlist is deliberate,
so a newly minted relationship is not admitted before anybody has judged it.

A rejection returns `422` listing up to ten of the references it objected to,
so one upload is usually enough to learn everything that has to change. `error`
is the first fault, `errors` holds them all when there was more than one, and
each target is cut to its first 120 characters with a trailing ellipsis when it
was longer:

```json
{
  "error": "external reference: link[href] https://fonts.googleapis.com/css2?family=Inter - inline the stylesheet; embed fonts as data: URIs in @font-face (a latin subset costs about 65 KB)",
  "errors": [
    "external reference: link[href] https://fonts.googleapis.com/css2?family=Inter - inline the stylesheet; embed fonts as data: URIs in @font-face (a latin subset costs about 65 KB)",
    "external reference: img[src] /logo.png",
    "external reference: style /background.png"
  ]
}
```

A refusal carries the answer beside the fault. `rel="stylesheet"` and a CSS
`@import` both say to inline the CSS. A `.woff2`, `.woff`, `.ttf`, `.otf`, or
`.eot` path anywhere, and a `link` that is `as="font"`, say to embed the
faces. So does a target naming fonts in a host label or a path segment -
`fonts.googleapis.com/css2?family=Inter`, `/fonts/faces.css` - but only on a
stylesheet, a `rel="preconnect"`, or a `rel="dns-prefetch"`, which have not
already said what they are fetching. An `<img src="/fonts/x.png">`, and a
`url()` in a declaration, name what they name: both are refused without the
font advice.

The size travels with the advice because the refusal is where the decision to
drop the fonts altogether otherwise gets made. See [Webfonts](#webfonts) for
the recipe.

At most ten faults are listed. A document with more carries `"truncated": true`
beside them, so the cap is never mistaken for the whole list.

Two refusals are about the markup rather than a reference. A `<style>` inside
`<svg>` is not raw text the way an HTML one is, and a stylesheet is built from
the element's direct text - so once another element opens inside it, or an end
tag turns up that might be closing an ancestor, where the rest of that text
belongs depends on HTML tree construction. Rather than guess, the check refuses
with `unsupported markup inside an svg style - keep the stylesheet to text
only`. Keeping the CSS to text, or moving it to an HTML `<style>`, resolves it;
text-only SVG stylesheets are read exactly, including the `<![CDATA[ ... ]]>`
form. A MathML element named `style` bears no stylesheet at all - the styling
element there is `mstyle` - so its text is not read as CSS.

The other refusal names nesting. `<svg>` and `<math>` change how everything
is read, and the parser this check uses follows that only for the plain
spellings: it enters on the start tag whether or not the tag closed itself, and
leaves only on an end tag matching the innermost one open. So a self-closing
`<svg/>` or `<math/>`, or end tags that cross as in `<svg><math></svg>`, leave
the parse describing something the browser is not reading - raw text becomes
markup, `<image>` stops being rewritten to `img`, SVG naming is applied to HTML -
after which no verdict is worth giving. Those are refused with `unsupported
nesting: a self-closing <svg/> or <math/>, or crossed svg/math end tags - give
each one its own end tag`. Writing `<svg></svg>` and closing each one in order
resolves it, and costs nothing: the balanced spelling is read normally.

Note that this is a static check. A plan's inline script can still call `fetch`
at runtime; the CSP sandbox is what contains it.

Plans are served from `GET /p/{id}`, and `/p/` is reserved for them alone.
Routing anything else under that prefix would out-rank the plan route and
silently shadow any plan holding that id, which is exactly the collision the
prefix exists to prevent. App routes go anywhere else; because they do, plan
ids need no reserved-word list.

### Webfonts

A webfont is a subresource like any other, so a branded document carries its
typefaces inside itself as `data:` URIs in `@font-face`. Nothing else will
work: `PLAN_CSP` serves plans under `font-src data: blob:` and no host, so a
font left outside the document would be blocked at render time even if the
upload gate let it through.

Four things make embedding cheaper than it first appears.

**A provider that already subsets saves you the toolchain.** Google Fonts
serves one `woff2` per script and puts every URL in the stylesheet it hands
out, so there is nothing to run `pyftsubset` over. A face you host yourself
may still need subsetting first.

**Ask for a weight range when you need several weights.** `wght@400..700`
returns one file per script subset and declares `font-weight: 400 700`.
`wght@400;500;600;700` returns the *same seven files* across 28 `@font-face`
rules, one per weight, because the face is variable and every weight resolves to
the same bytes. Embed from the list form and you paste four identical base64
blobs into the document for no benefit.

**Ask for one weight when one is all you need.** The range form is not free:
`wght@400..700` and `wght@400;700` both serve Inter's latin subset as the same
48,432-byte variable file, but `wght@400` alone serves a 23,804-byte static
instance. Widening a range costs nothing - `wght@100..900` is that same 48,432
bytes - so the choice is between one variable file and one static one, and a
document using a single weight per family halves its font payload by asking for
exactly that.

The subset name lives in a comment above each `@font-face`, and the URLs are
opaque hashes, so pair them up rather than reading the URLs:

```sh
# A modern desktop user-agent is required - Google serves unsubsetted TTF to
# anything it does not recognise as woff2-capable, with no subset comments.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '\
'(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

# Prints "subset<TAB>url" for every face in the stylesheet
curl -s 'https://fonts.googleapis.com/css2?family=Inter:wght@400..700' \
  -H "user-agent: $UA" \
  | awk '/^\/\* /{s=$2} /src: url\(/{match($0,/https:[^)]+/);
         print s"\t"substr($0,RSTART,RLENGTH)}'

# Then turn the row you want into a complete data: URI, ready to paste. The
# download is checked first, so an error page cannot be encoded as a font.
curl -fsSL '<the latin woff2 URL>' -o face.woff2 \
  && printf 'data:font/woff2;base64,%s\n' "$(base64 < face.woff2 | tr -d '\n')"
```

Declare the range you asked for, so one blob serves every weight in it:

```css
@font-face {
  font-family: Inter;
  font-weight: 400 700;
  src: url(data:font/woff2;base64,d09GMgABAAAA...) format("woff2");
}
```

**The latin subset is small.** Base64 costs a third on top of the raw bytes,
and a latin subset is tens of kilobytes to begin with. Measured on a real
three-family document:

| family                        | latin files    | raw    |
| ----------------------------- | -------------- | ------ |
| IBM Plex Sans 400-700         | 1 (variable)   | 40,240 |
| Inter 400-700                 | 1 (variable)   | 48,432 |
| IBM Plex Mono 400 / 500 / 600 | 3 (static)     | 30,232 |

Five files and 119 KB raw finished as a 202 KB document - under 10% of the
default 2 MB `MAX_UPLOAD_BYTES`. Note the two variable families collapsing four
declared weights into one file each; that is where the range form pays.

Check the provider's licence before redistributing a face inside a document.
Open licences such as the SIL OFL permit it; many commercial licences do not.

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
