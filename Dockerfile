# syntax=docker/dockerfile:1

# Bun is required at runtime regardless of driver: `dist/server/index.js` is
# bundled with `bun build --target=bun`. `DB_DRIVER=sqlite` needs `bun:sqlite`
# on top of that. Postgres is still the recommended self-host driver.
FROM docker.io/oven/bun:1-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
# `scripts/vendor-scalar.ts` runs on postinstall and has to be present before
# the source tree is. It imports nothing, precisely so this one file is enough.
COPY package.json bun.lock ./
COPY scripts/vendor-scalar.ts ./scripts/
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run build

# Applies Drizzle migrations. Needs the source tree and dev dependencies, which
# the runtime stage deliberately does not carry. Run it as a one-shot job.
FROM build AS migrate
USER bun
ENTRYPOINT ["bun", "run", "db:migrate:pg"]

FROM base AS runtime
ENV PORT=3000

RUN apk add --no-cache curl && mkdir -p /app/data && chown bun:bun /app/data

# One self-contained bundle plus the client assets it serves. No source tree
# and no node_modules: `bun build --target=bun` inlines every dependency, so
# the runtime image carries neither.
# `bun` (uid 1000) ships with the image.
COPY --from=build --chown=bun:bun /app/dist ./dist

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

CMD ["bun", "dist/server/index.js"]
