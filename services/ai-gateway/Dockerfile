# Multi-stage build for @yiji/ai-gateway.
# Build from the monorepo ROOT:  docker build -f services/ai-gateway/Dockerfile -t yiji/ai-gateway .
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
COPY services/ai-gateway/package.json ./services/ai-gateway/
RUN pnpm install --frozen-lockfile --prod --filter @yiji/ai-gateway...

# ---- runner ----
FROM base AS runner
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/services/ai-gateway/node_modules ./services/ai-gateway/node_modules
COPY packages/shared-config ./packages/shared-config
COPY packages/shared-types ./packages/shared-types
COPY tsconfig.base.json ./
COPY services/ai-gateway ./services/ai-gateway

WORKDIR /app/services/ai-gateway
USER node
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
