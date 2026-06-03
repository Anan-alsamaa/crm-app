# Build from the monorepo root: docker build -f services/socket-gateway/Dockerfile .
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

# Install workspace deps (cached on lockfile).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/socket-gateway ./services/socket-gateway
RUN pnpm install --frozen-lockfile --filter @yiji/socket-gateway...

WORKDIR /app/services/socket-gateway
EXPOSE 8080 8081
CMD ["pnpm", "start"]
