# Rentwell container images.
#
# One Dockerfile, three targets: api, worker, web. They share a single
# dependency-installation layer, so a change to application code does not
# reinstall node_modules.
#
# Only the API and worker run Node in production; the web build is static and is
# served by nginx.

# ---------------------------------------------------------------------------
# Base: pnpm on Node 20
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# OpenSSL is required by Prisma's query engine; argon2 needs a toolchain to
# build if no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Dependencies: manifests only, so this layer caches across code changes
# ---------------------------------------------------------------------------
FROM base AS deps
# pnpm-lock.yaml is not optional here: the install below is --frozen-lockfile,
# which refuses to run without it. It also pins the root `pnpm.overrides`, so a
# missing lockfile fails the build rather than quietly resolving new versions.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/domain/package.json          packages/domain/
COPY packages/database/package.json        packages/database/
COPY packages/graphql/package.json         packages/graphql/
COPY packages/integrations/package.json    packages/integrations/
COPY packages/observability/package.json   packages/observability/
COPY packages/test-fixtures/package.json   packages/test-fixtures/
COPY apps/api/package.json                 apps/api/
COPY apps/worker/package.json              apps/worker/
COPY apps/web/package.json                 apps/web/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build: compile every workspace package once
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
# The Prisma client is generated before compilation, because the API's types
# depend on it.
RUN pnpm --filter @rentwell/database generate
RUN pnpm -r --filter "./packages/**" build
RUN pnpm --filter @rentwell/api build
RUN pnpm --filter @rentwell/worker build
RUN pnpm --filter @rentwell/web build

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
WORKDIR /app/apps/api

# Never run as root.
RUN useradd --system --uid 10001 rentwell && chown -R rentwell /app
USER rentwell

EXPOSE 4000
# Signals reach Node directly rather than through a shell, so SIGTERM triggers
# the graceful shutdown the application implements.
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/worker ./apps/worker
WORKDIR /app/apps/worker

RUN useradd --system --uid 10001 rentwell && chown -R rentwell /app
USER rentwell

CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------
# Web: static assets behind nginx
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
