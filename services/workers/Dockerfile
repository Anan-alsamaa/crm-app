# Build from the monorepo root: docker build -f services/workers/Dockerfile .
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/workers ./services/workers
RUN pnpm install --frozen-lockfile --filter @yiji/workers...

WORKDIR /app/services/workers
EXPOSE 8090
CMD ["pnpm", "start"]
