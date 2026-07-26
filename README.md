# BunkerPlan

Upload a standalone HTML document, get a public URL at `https://{host}/p/{id}`.

- **Passkeys only.** No email, no username, no password, no OAuth. A brand-new
  visitor registers with nothing but a passkey, and one WebAuthn prompt signs
  them straight in.
- **API keys** for automation - as many as you want, expiry optional. A key
  authorises upload, replacement, and delete for its owner's plans and nothing
  else.
- **Runs on Cloudflare or your own box** from one source tree: R2/D1/KV on
  Workers, any S3-compatible store + Postgres/SQLite + Valkey when self-hosted.

## Develop

```sh
git clone https://github.com/bunkerlab-net/bunkerplan.git && cd bunkerplan
bun install
cp .env.example .env                              # set BETTER_AUTH_SECRET
bunx wrangler d1 migrations apply bunkerplan --local
bun run dev
```

| Script                                 | What it does                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `bun run dev`                          | Vite dev server on the Workers runtime (Miniflare)                                                      |
| `bun run build` / `bun run build:node` | Build for Workers / Node                                                                                |
| `bun run deploy`                       | Build and `wrangler deploy` (refuses while `wrangler.jsonc` still holds dev placeholders)               |
| `bun run db:generate`                  | Regenerate migration SQL for both dialects                                                              |
| `bun run auth:generate:sqlite` / `:pg` | Regenerate the Better Auth schema - **re-apply the hand patch noted at the top of each generated file** |
| `bun run test`                         | The whole suite. Skips the container-backed backends unless they are up - see Tests                     |
| `bun run test:backends`                | Postgres, Valkey, and MinIO on localhost, so nothing skips                                              |
| `bun run check`                        | Biome lint and format                                                                                   |
| `bun run typecheck`                    | `tsc --noEmit`                                                                                          |

## Tests

Six stores ship: D1, R2, and Workers KV on Cloudflare; Postgres, MinIO, and
Valkey when self-hosted. `tests/drivers/` holds one conformance suite per
interface and runs it against every implementation, so a difference between
two backends fails an assertion instead of surfacing on one deployment and not
the other. Nothing there is a fake - the Cloudflare three run on real workerd
via Miniflare, the rest against containers.

The Cloudflare half needs nothing installed. The other three are opt-in by
environment variable and **skip** when it is absent, so `bun run test` on a
checkout with no Docker still passes - having exercised rather less than it
looks. To run everything:

```sh
bun run test:backends   # postgres, valkey, minio, published on localhost
TEST_DATABASE_URL=postgres://bunkerplan:bunkerplan@127.0.0.1:5432/bunkerplan \
TEST_VALKEY_URL=redis://127.0.0.1:6379 \
TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
  bun run test
bun run test:backends:down
```

Or uncomment the same variables in your local environment file - `bun test`
reads it - and `bun run test` alone runs the full matrix. `.env.example`
documents all five, including the two S3 credentials that default to the
compose MinIO.

CI sets them, so a pull request always runs the full matrix. Nothing here
can reach data you care about: the backends run under their own Compose
project (`bunkerplan-test`), separate from the self-hosting stack below, so
`test:backends:down -v` cannot take your local Postgres, Valkey, or MinIO
volumes with it. Postgres then works in a scratch schema and MinIO in a bucket
created for the run, both dropped afterwards.

`bun run test` is `bun test --parallel`, one process per file, and that is not
a speed choice: Miniflare runs a workerd child process, and sharing a process
with the AWS SDK intermittently wedges a concurrent S3 request that then never
settles.

## Self-hosting

See [docs/self-hosting.md](docs/self-hosting.md) for the environment contract,
the driver swap matrices, AWS credential guidance, and the operational warnings.
`docker compose up --build -d` brings up the whole stack against Postgres,
Valkey, and MinIO.

## API

```sh
curl -X PUT "https://plans.example.com/api/plans?label=Q3%20rollout" \
  -H "x-api-key: bkp_..." -H "content-type: text/html" \
  --data-binary @plan.html
# 201 {"id":"...","url":"https://plans.example.com/p/...","label":"Q3 rollout"}

curl -X PUT https://plans.example.com/api/plans/<id> \
  -H "x-api-key: bkp_..." -H "content-type: text/html" \
  --data-binary @revised.html
# 200 {"id":"...","url":"https://plans.example.com/p/..."}

curl -X DELETE https://plans.example.com/api/plans/<id> -H "x-api-key: bkp_..."
# 204
```

`label` is optional and owner-facing: it names a plan in the dashboard and in
`GET /api/plans`, but never reaches the stored object or the public URL. The
dashboard edits labels in place; the id stays the identity either way.

Uploading to an id you already own replaces the document behind it: same URL,
same label, new bytes. Somebody else's id is a `404` and their object is never
touched. Caches hold a plan for five minutes, so a replacement can take that
long to reach a visitor who has already seen the old one.

Uploads must be self-contained: no external scripts, stylesheets, images,
iframes, or CSS `url()`/`@import` targets, including relative paths, and no
non-empty `iframe[srcdoc]`. Inline `<style>`, inline `<script>`, `data:` URIs
and ordinary links are fine. A rejection returns `422` naming the offending
`tag[attribute]`.

Plans are served with `Content-Security-Policy: sandbox`, which puts each
document in an opaque origin so it cannot reach the uploader's session.

`GET /healthz` returns `200` when storage, the database, and KV are all
reachable, `503` naming the ones that are not. It is a self-hosting probe and
`404`s on Cloudflare, where nothing polls it and an unauthenticated public
request would otherwise cost three billable backend operations.
