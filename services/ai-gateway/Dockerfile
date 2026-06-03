# Build from the monorepo root: docker build -f services/ai-gateway/Dockerfile .
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/ai-gateway ./services/ai-gateway
RUN pnpm install --frozen-lockfile --filter @yiji/ai-gateway...

WORKDIR /app/services/ai-gateway
EXPOSE 8081
CMD ["pnpm", "start"]
