# Multi-stage build for @yiji/directus-bootstrap (one-shot job, not a daemon).
# Build from the monorepo ROOT:
#   docker build -f directus/bootstrap/Dockerfile -t yiji/bootstrap .
#
# Runs `apply` against a healthy Directus: creates collections, fields,
# relations, roles/policies, raw-SQL constraints, and seeds each service user's
# static token from the SVC_* env. Idempotent — safe to re-run. The container
# exits 0 on success, non-zero on failure, so it composes as a gate:
#   docker compose -f docker-compose.prod.yml run --rm bootstrap
#
# Stages mirror the service images (services/*/Dockerfile):
#   base       — node:20-alpine + corepack (pnpm) + tini (clean signals)
#   prod-deps  — production-only dependency tree (tsx stays as the TS runtime)
#   runner     — minimal final image: prod node_modules + source, non-root
FROM node:20-alpine AS base
RUN corepack enable && apk add --no-cache tini
WORKDIR /app

# ---- dependencies (cached on manifests + lockfile) ----
# NOT --prod: this package keeps `tsx` (its TS runtime) in devDependencies, so a
# prod-only install would drop the very binary the CMD runs. The extra dev deps
# (typescript, @types) are harmless in a one-shot job image that exits.
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY directus/bootstrap/package.json ./directus/bootstrap/
RUN pnpm install --frozen-lockfile --filter @yiji/directus-bootstrap...

# ---- runner ----
FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/directus/bootstrap/node_modules ./directus/bootstrap/node_modules
COPY packages/shared-types ./packages/shared-types
# shared-types' own deps (resolved via the copied root .pnpm store) — without
# these the bootstrap can't resolve its workspace import at runtime.
COPY --from=deps /app/packages/shared-types/node_modules ./packages/shared-types/node_modules
COPY tsconfig.base.json ./
COPY directus/bootstrap ./directus/bootstrap

WORKDIR /app/directus/bootstrap
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/apply.ts"]
