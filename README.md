# BunkerPlan

Upload a standalone HTML document, get a public URL at `https://{host}/p/{id}`.

- **Passkeys only.** No email, no username, no password, no OAuth. A brand-new
  visitor registers with nothing but a passkey, and one WebAuthn prompt signs
  them straight in.
- **API keys** for automation - as many as you want, expiry optional. A key
  authorises upload and delete for its owner's plans and nothing else.
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
| `bun test`                             | Unit tests                                                                                              |
| `bun run check`                        | Biome lint and format                                                                                   |
| `bun run typecheck`                    | `tsc --noEmit`                                                                                          |

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

curl -X DELETE https://plans.example.com/api/plans/<id> -H "x-api-key: bkp_..."
# 204
```

`label` is optional and owner-facing: it names a plan in the dashboard and in
`GET /api/plans`, but never reaches the stored object or the public URL. The
dashboard edits labels in place; the id stays the identity either way.

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
