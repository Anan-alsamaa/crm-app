# Multi-stage build for @yiji/socket-gateway.
# Build from the monorepo ROOT:  docker build -f services/socket-gateway/Dockerfile -t yiji/socket-gateway .
#
# Stages:
#   base       — node:20-alpine + corepack (pnpm) + tini (PID 1 / signal forwarding)
#   prod-deps  — production-only dependency tree (no typescript/@types/mocks).
#                tsx stays because it is the runtime (transpiles TS on the fly;
#                deliberately NOT bundled so OTel auto-instrumentation keeps working).
#   runner     — minimal final image: prod node_modules + source, non-root.
FROM node:20-alpine AS base
RUN corepack enable && apk add --no-cache tini
WORKDIR /app

# ---- production dependencies (cached on manifests + lockfile) ----
FROM base AS prod-deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared-config/package.json ./packages/shared-config/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY services/socket-gateway/package.json ./services/socket-gateway/
RUN pnpm install --frozen-lockfile --prod --filter @yiji/socket-gateway...

# ---- runner ----
FROM base AS runner
ENV NODE_ENV=production
# Prod dependency tree (incl. the pnpm virtual store + workspace symlinks).
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/services/socket-gateway/node_modules ./services/socket-gateway/node_modules
# Application + workspace package source (consumed as TS by tsx at runtime).
COPY packages/shared-config ./packages/shared-config
COPY packages/shared-types ./packages/shared-types
COPY tsconfig.base.json ./
COPY services/socket-gateway ./services/socket-gateway

WORKDIR /app/services/socket-gateway
USER node
# 8080 = Socket.IO; 8081 = Fastify health/ready/metrics (PORT + 1).
EXPOSE 8080 8081
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
