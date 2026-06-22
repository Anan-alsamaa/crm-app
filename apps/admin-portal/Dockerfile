# Multi-stage build for @yiji/admin-portal (Vite SPA → static nginx image).
# Build from the monorepo ROOT:
#   docker build -f apps/admin-portal/Dockerfile -t yiji/admin-portal \
#     --build-arg VITE_DIRECTUS_URL=https://directus.example.com .
#
# NOTE: Vite inlines VITE_* at BUILD time, so they are baked into the bundle and
# shipped to the browser. Only put non-secret, client-safe values here. (The
# default prod hosting for the portals is a CDN/static host — see
# docs/PRODUCTION.md; this image is the container alternative.)
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

# Workspace manifests + lockfile first (better layer caching on install).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/admin-portal ./apps/admin-portal
RUN pnpm install --frozen-lockfile --filter @yiji/admin-portal...

# Public (client-baked) build-time config. Defaults are dev-local; override per
# environment with --build-arg. Tokens default empty — never bake real secrets.
ARG VITE_DIRECTUS_URL=http://localhost:8055
ARG VITE_SOCKET_URL=http://localhost:8080
ARG VITE_AI_GATEWAY_URL=http://localhost:8081
ARG VITE_AI_SVC_TOKEN=
ARG VITE_YIJI_API_URL=
ARG VITE_YIJI_API_TOKEN=
# Job enqueue endpoint (Import CSV / Run report now). Prod: the socket-gateway's
# HTTP base URL (it exposes authed POST /jobs/*). Dev default: host job-producer.
ARG VITE_JOB_PRODUCER_URL=http://localhost:3031
ARG VITE_JOB_PRODUCER_TOKEN=
ENV VITE_DIRECTUS_URL=$VITE_DIRECTUS_URL \
    VITE_SOCKET_URL=$VITE_SOCKET_URL \
    VITE_AI_GATEWAY_URL=$VITE_AI_GATEWAY_URL \
    VITE_AI_SVC_TOKEN=$VITE_AI_SVC_TOKEN \
    VITE_YIJI_API_URL=$VITE_YIJI_API_URL \
    VITE_YIJI_API_TOKEN=$VITE_YIJI_API_TOKEN \
    VITE_JOB_PRODUCER_URL=$VITE_JOB_PRODUCER_URL \
    VITE_JOB_PRODUCER_TOKEN=$VITE_JOB_PRODUCER_TOKEN
RUN pnpm --filter @yiji/admin-portal build

# ---- runner: nginx serving the static build with SPA history fallback ----
FROM nginx:1.27-alpine AS runner
COPY --from=builder /app/apps/admin-portal/dist /usr/share/nginx/html
# SPA fallback (client-side routing) + a cheap /health for container probes.
# Baseline security headers baked in so the image is safe even if served without
# the Caddy edge. HSTS is intentionally left to the TLS terminator (Caddy).
RUN printf 'server {\n  listen 80;\n  server_name _;\n  root /usr/share/nginx/html;\n  add_header X-Content-Type-Options "nosniff" always;\n  add_header X-Frame-Options "DENY" always;\n  add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n  location = /health { return 200 "ok"; add_header Content-Type text/plain; }\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health || exit 1
CMD ["nginx", "-g", "daemon off;"]
