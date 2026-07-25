# syntax=docker/dockerfile:1

# Bun is required at runtime: DB_DRIVER=sqlite goes through `bun:sqlite`.
# The recommended self-host driver is postgres, which works on either runtime.
FROM docker.io/oven/bun:1-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN BUILD_TARGET=node bun run build

# Applies Drizzle migrations. Needs the source tree and dev dependencies, which
# the runtime stage deliberately does not carry. Run it as a one-shot job.
FROM build AS migrate
USER bun
ENTRYPOINT ["bun", "run", "db:migrate:pg"]

FROM base AS runtime
ENV PORT=3000

RUN apk add --no-cache curl && mkdir -p /app/data && chown bun:bun /app/data

# `bun` (uid 1000) ships with the image.
COPY --from=build --chown=bun:bun /app/.output ./.output

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

CMD ["bun", ".output/server/index.mjs"]
