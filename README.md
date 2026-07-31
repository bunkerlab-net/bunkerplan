# BunkerPlan

Upload a standalone HTML document, get a URL at `https://{host}/p/{id}`.

- **Private by default.** A plan is readable by its owner alone until it is
  shared - with anyone holding the URL, with a share code, or with named
  accounts. A code keeps working until it is regenerated or removed; only its
  plaintext is shown once, at the moment it is minted.
- **Passkeys only.** No email, no username, no password, no OAuth. A brand-new
  visitor registers with nothing but a passkey, and one WebAuthn prompt signs
  them straight in.
- **API keys** for automation - as many as you want, expiry optional. A key
  authorises upload, replacement, delete, and reading any plan its owner may
  read; it cannot change who a plan is shared with.
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
| `bun run dev`                          | `wrangler dev` on the Workers runtime, plus a client rebuild-on-save watcher                            |
| `bun run dev:node`                     | The same, against the self-hosted Bun entry instead                                                     |
| `bun run build`                        | Bundles the browser entry, the asset manifest, and the self-hosted server into `dist/`                  |
| `bun run deploy`                       | Build and `wrangler deploy` (refuses while `wrangler.jsonc` still holds dev placeholders)               |
| `bun run db:generate`                  | Regenerate migration SQL for both dialects                                                              |
| `bun run auth:generate:sqlite` / `:pg` | Regenerate the Better Auth schema - overwrites the file wholesale, so nothing hand-written survives it   |
| `bun run test`                         | Builds, then runs the whole suite with coverage. Partial by default: the container-backed suites run only when their `TEST_*` variables are set - see Tests |
| `bun run test:backends`                | Starts Postgres, Valkey, and MinIO on localhost; set the `TEST_*` variables to reach them               |
| `bun run check`                        | Biome lint and format                                                                                   |
| `bun run typecheck`                    | Builds, then `tsc --noEmit`                                                                             |

`build` comes first in three of those because it writes
`src/server/manifest.generated.ts` - the hashed filenames of the browser
bundle, which the server renders into `<link>` and `<script>`. It takes about
300ms.

## Stack

[Hono](https://hono.dev) on Web-standard `Request`/`Response`, which is what
lets one source tree serve workerd and Bun without an adapter. `src/worker.ts`
and `src/node.ts` name their own runtime wiring; everything in `src/http/` is a
plain `(Request) => Response` function that neither Hono nor the tests need a
server to exercise.

Pages are `hono/jsx` on the server and `hono/jsx/dom` in the browser - the same
components, server-rendered and then hydrated, so the landing copy is in the
HTML for crawlers rather than swapped in after boot. `scripts/build.ts` is the
whole build: it replaces Vite, so asset hashing, the `public/` copy, and the
manifest are project-owned rather than plugin behaviour. The Worker itself is
bundled by `wrangler deploy`, which is the thing that understands
`nodejs_compat`.

There is no HMR. Save a file and `bun run dev` rebuilds; reload the tab.

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

CI sets them, so a pull request always runs the full matrix - across two steps
rather than one: the main step carries Postgres and MinIO, and Valkey gets a
step of its own for the reason below. Nothing here
can reach data you care about: the backends run under their own Compose
project (`bunkerplan-test`), separate from the self-hosting stack below, so
`test:backends:down -v` cannot take your local Postgres, Valkey, or MinIO
volumes with it. Postgres then works in a scratch schema and MinIO in a bucket
created for the run, both dropped afterwards.

One command, `bun run test`. It builds first, because the suite serves the
real Workers bundle on Miniflare; `BUNKERPLAN_PREBUILT=1` is what stops each
worker rebuilding it. Coverage is on in `bunfig.toml`, so every run reports a
figure - and that figure counts only what ran, so a run with the backends
absent measures a smaller suite than the full matrix does.

The run is `--isolate`, which gives each file its own module registry. That is
the topology that measures coverage correctly. `--parallel` does not: its
reporter registers lines that are not statements - comments, blank lines, the
continuation lines of a multi-line string - as coverable and unhit in workers
that loaded a module without exercising it. Measured on this repo under Bun
1.3.14, that invents 1583 such lines and reports 86% where the same run
measures 99.5% in one process, with `src/client/errors.ts` at 44% and every
branch in it covered. That is one observation of one toolchain: in it, no real
line was found by one topology and missed by the other, and only the
denominator moved. A later Bun may report differently.

What `--isolate` costs is one process for all 61 files. It gives each file its
own module registry, not its own process, and the Valkey client is what stops
working there: commands stop completing, and a block of tests fails together
at almost exactly 5000ms, Bun's per-test timeout.

What is measured is the correlation, not the mechanism. Three full runs failed
26, 22 and 4 tests; every failure in all three was the Valkey suite and
nothing else failed in any of them. The same file in its own process passed
five runs out of five. The server is not the slow part - it sat at
0.3% CPU with an empty slowlog and `timeout 0` throughout, and a standalone
script that opens one client, waits out a ttl and reads it back did 40 rounds
without a hang. What is *not* established is why sharing the process does it:
the backend fixtures each dispose of their handles in `afterAll`, so "the
process is holding everything at once" is a description of the topology and
not a diagnosis. Nobody has isolated the interaction.

So the Valkey suite runs in its own step in CI, and `TEST_VALKEY_URL` is not
set on the main one - see .github/workflows/check.yaml. Every assertion still
runs exactly once. Locally, `bun run test` with `TEST_VALKEY_URL` set is the
shared process again, and can still hang there:

```sh
bun run build # BUNKERPLAN_PREBUILT=1 below promises this already happened
TEST_VALKEY_URL=redis://localhost:6379 \
  BUNKERPLAN_PREBUILT=1 bun test --isolate ./tests/drivers/kv-store.valkey.test.ts
```

The variable is not optional there: without it the suite skips and the command
passes having run nothing. Same for the repeat below - a backend whose variable
is missing is a backend that was not tested.

A red run is not evidence on its own - but neither is one green re-run, which
is the trap. A single pass says nothing about a failure that happens some of
the time. Repeat it instead:

```sh
BUNKERPLAN_PREBUILT=1 bun test --isolate --rerun-each 5 tests/drivers/
```

That command carries no variables of its own, so it needs them in the
environment: uncomment them in your local environment file, which `bun test`
reads, or `export` the ones the setup block above passes per-command. All of
them, not just the one for the driver under suspicion - the point is to keep
the other files in the picture. Without them the drivers skip and the repeat
proves nothing, five times.

Repetition narrows it, it does not decide it. A genuine regression tends to
fail every repetition and to fail on its own assertion; the flake tends to
fail a minority of them, at the deadline, in a whole block at once. Read the
assertion that failed and the surrounding output before calling anything
environmental - a real bug that only shows up under load wears the flake's
shape exactly. Anything that does not fit the flake's shape is a regression
until the evidence says otherwise.

## Self-hosting

See [docs/self-hosting.md](docs/self-hosting.md) for the environment contract,
the driver swap matrices, AWS credential guidance, and the operational warnings.
`docker compose up --build -d` brings up the whole stack against Postgres,
Valkey, and MinIO.

## API

Browse it at `/api/docs` - a [Scalar](https://scalar.com) reference over
`/api/openapi.json`. The document is built from the Zod schemas the handlers
answer with (`src/api/schemas.ts`), so a response shape that drifts from the
published spec fails `tsc`, and `tests/openapi.test.ts` fails a route that
ships undescribed. `servers` and the upload cap come from the running
deployment, not from this repository's defaults.

Scalar's browser bundle is copied out of a devDependency into `public/scalar/`
on `postinstall`, so the page loads nothing off-origin and nothing from a CDN.

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
and ordinary links are fine, as are the `link` relationships that fetch
nothing: `canonical`, `alternate`, `license`, `prev`, `next`, `me`. Anything
else is refused, including an unrecognised `rel` and combinations such as
`alternate stylesheet`, which is still a stylesheet. A rejection returns `422`
listing up to ten of the references it objected to, each named with the target
it pointed at and cut to 120 characters, and carrying `truncated` when there
were more than it listed - so one upload is usually enough to learn everything
that has to change. Two refusals name markup instead of a reference: an element
inside an SVG `<style>`, and foreign nesting the check cannot follow - a
self-closing `<svg/>` or `<math/>`, or end tags that cross. Neither costs a
legitimate document anything: keep that stylesheet to text, and give each
`<svg>` and `<math>` its own end tag in order, and both are read normally.
The full response shape is under
[API](docs/self-hosting.md#api) in the self-hosting guide.

Webfonts are covered by that, so a branded document carries its typefaces as
`data:` URIs in `@font-face`. That is cheaper than it sounds - a latin subset
of a variable face costs about 65 KB encoded, and a provider that already
serves subsets saves you a subsetting step. See
[Webfonts](docs/self-hosting.md#webfonts) for the recipe.

Plans are served with `Content-Security-Policy: sandbox`, which puts each
document in an opaque origin so it cannot reach the uploader's session.

`GET /healthz` returns `200` when storage, the database, and KV are all
reachable, `503` naming the ones that are not. It is a self-hosting probe and
`404`s on Cloudflare, where nothing polls it and an unauthenticated public
request would otherwise cost three billable backend operations.
