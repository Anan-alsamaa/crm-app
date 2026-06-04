# Production deployment

This document covers what to set, what to scale, and what to watch when
deploying YIJI CRM to a production environment.

## Topology

The system runs as five long-lived processes plus the three SPAs and the
embeddable widget bundle. Everything is stateless except Postgres and
Redis.

```
                       ┌──────────────────────┐
   Customer browser ──▶│  CDN / static host   │  yiji-chat-widget.js (IIFE)
                       └──────────┬───────────┘
                                  │  /socket.io
                                  ▼
         ┌──────────────┐   ┌──────────────────┐   ┌────────────────┐
         │ Agent portal │──▶│  socket-gateway  │◀──│  Redis 7       │
         └──────────────┘   │  (Fastify + IO)  │   │  (adapter +    │
         ┌──────────────┐   │  N instances     │   │   pub/sub +    │
         │ Admin portal │──▶└────────┬─────────┘   │   BullMQ +     │
         └──────────────┘            │             │   AI cache +   │
                                     │   write     │   rate limit)  │
                                     ▼             └────────┬───────┘
                              ┌──────────────┐              │
                              │   Directus   │◀─────────────┘
                              │   (Postgres) │   read by every service
                              └────────┬─────┘
                                       │
         ┌────────────┐   pull jobs    │            ┌──────────────────┐
         │  workers   │───────────────▶│            │   ai-gateway     │
         │  N inst.   │                │◀───────────│   (Fastify)      │
         │            │   read context │   read     │   Gemini outbound│
         └────────────┘                ▼            └──────────────────┘
                              ┌──────────────┐
                              │   SMTP       │
                              │   (notif +   │
                              │    reports)  │
                              └──────────────┘
```

## Required environment overrides

Every value below MUST differ from the `.env.example` defaults in
production. Generate secrets with `openssl rand -hex 32`.

| Variable                  | Why it matters                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `DIRECTUS_ADMIN_PASSWORD` | Owner admin password (the dev value is `123456` — never ship it)                         |
| `DIRECTUS_KEY`            | Directus internal signing key                                                            |
| `DIRECTUS_SECRET`         | Directus internal secret                                                                 |
| `YIJI_JWT_SECRET`         | Customer widget JWT signing secret (HS256) — rotate with the host page                   |
| `SVC_GATEWAY_TOKEN`       | Service-account static token used by socket-gateway → Directus                           |
| `SVC_WORKERS_TOKEN`       | Service-account static token used by workers → Directus                                  |
| `SVC_AI_TOKEN`            | Service-account static token used by ai-gateway → Directus + clients calling the gateway |
| `CORS_ORIGIN`             | Set to your portal hostnames on every Node service — no `*` in prod                      |
| `REDIS_URL`               | Real Redis 7+ (managed or self-hosted), TLS-terminated                                   |
| `SMTP_*`                  | Real SMTP relay for notifications + scheduled reports                                    |

Optional but recommended:

| Variable                             | Effect when set                                          |
| ------------------------------------ | -------------------------------------------------------- |
| `GEMINI_API_KEY`                     | AI endpoints stop returning `not_configured` 503         |
| `YIJI_API_URL` + `YIJI_API_KEY`      | YijiClient switches from mock to HTTP commerce lookups   |
| `STORAGE_DRIVER=s3` + `STORAGE_S3_*` | Off-host file storage for Directus uploads + CSV imports |
| `YIJI_JWT_PUBLIC_KEY`                | Reserved — flip the widget JWT verifier to RS256         |

## Building

Each app and service builds independently:

```bash
pnpm install --frozen-lockfile
pnpm -r --if-present build
```

The chat widget produces a single IIFE bundle (`apps/chat-widget/dist/yiji-chat-widget.js`)
intended for static / CDN hosting. The two portals produce standard Vite
build output (`apps/<portal>/dist/`). The three Node services are run from
source via `tsx` or compiled per their service-specific Dockerfile.

## Deploying

### Containers (recommended)

The repo ships a `docker-compose.yml` covering the local dev stack. For
production, replace it with your container orchestrator of choice
(Kubernetes / ECS / Fly / Render). Each service is:

| Service          | Image base                   | Port                 | Healthcheck          |
| ---------------- | ---------------------------- | -------------------- | -------------------- |
| `directus`       | `directus/directus` (latest) | 8055                 | `GET /server/health` |
| `socket-gateway` | `node:20-alpine`             | 8080 (+ 8081 health) | `GET :8081/health`   |
| `workers`        | `node:20-alpine`             | 8090 health          | `GET :8090/health`   |
| `ai-gateway`     | `node:20-alpine`             | 8081                 | `GET /health`        |
| `agent-portal`   | static (Nginx / S3 + CDN)    | 80/443               | n/a                  |
| `admin-portal`   | static (Nginx / S3 + CDN)    | 80/443               | n/a                  |
| `chat-widget`    | static (CDN)                 | 80/443               | n/a                  |

Run multiple instances of `socket-gateway` and `workers`. They coordinate
via Redis (Socket.IO adapter for cross-instance message broadcast; BullMQ
for queue distribution).

## Scaling

| Component        | Strategy                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socket-gateway` | Horizontal. Place behind an L4/L7 LB with **sticky sessions** (Socket.IO long-polling fallback needs them). Redis adapter takes care of cross-instance pub/sub. |
| `workers`        | Horizontal. BullMQ distributes jobs across instances by queue name. No coordination needed beyond Redis.                                                        |
| `ai-gateway`     | Horizontal. Stateless. Rate limit + cache are Redis-backed.                                                                                                     |
| Postgres         | Vertical. Read replicas optional for reporting if write volume is high.                                                                                         |
| Redis            | Single instance is fine until throughput justifies a Redis Cluster.                                                                                             |

## Observability

Every Node service emits structured JSON logs via pino — pipe to your log
aggregator. Both `/health` and `/ready` are exposed; `/ready` returns 503
if Redis isn't reachable. No metrics endpoint ships yet — add a Prometheus
exporter alongside each service if you need one.

## Security checklist

- [ ] Every secret in `.env.example` overridden.
- [ ] `DIRECTUS_ADMIN_PASSWORD` is not `123456`.
- [ ] `CORS_ORIGIN` is an exact-match allow-list, not `*`.
- [ ] TLS termination in front of every HTTP service.
- [ ] WebSockets terminate over WSS (sticky-session LB).
- [ ] Redis bound to private network or TLS-only, password-protected.
- [ ] Postgres bound to private network, distinct service user.
- [ ] File storage uses signed-URL access for uploads.
- [ ] Webhooks (if exposed) verify the signature in the request header.
- [ ] PII redaction enabled on the AI gateway (default in shipped code).
- [ ] Monthly AI cap set per the budget; per-user + global rate limits tuned.
- [ ] Append-only `ticket_events` permission is intact on the Directus role
      (no UPDATE / DELETE for Agent / Admin).

## Disaster recovery

- **Postgres**: nightly + continuous WAL backup. Test restore quarterly.
- **Directus uploads**: included in the storage-driver snapshot
  (local FS snapshot or S3 lifecycle config).
- **Redis**: ephemeral by design. Lost queue data = lost scheduled jobs
  (SLA reconcile sweep re-creates SLA timers within 60s; other jobs are
  best-effort).
- **Schema drift**: keep `directus/snapshot/` in sync via `directus schema export`
  on every change; `directus/bootstrap/` is the canonical source.

## Operational runbook

| Symptom                                   | Likely cause                                             | Fix                                             |
| ----------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Widget shows "connecting / reconnecting"  | socket-gateway down or Redis unreachable                 | Check `/ready` on each gateway instance         |
| Agent inbox not refreshing in realtime    | One gateway instance unable to talk to Redis             | Restart instance; verify Redis VPC reachability |
| AI endpoints return `not_configured`      | `GEMINI_API_KEY` empty                                   | Set the env var on ai-gateway                   |
| AI endpoints return `monthly_cap_reached` | Vendor hit its monthly budget                            | Bump cap in Admin → AI assistance               |
| Notifications not delivered               | `SMTP_*` empty or transport unreachable                  | Inspect workers logs; verify SMTP creds         |
| SLA warnings/breaches missed              | workers process not running                              | Check workers `/health`; restart instance       |
| Scheduled report not emailed              | `schedule.email` recipients absent or SMTP misconfigured | Verify report row + workers SMTP env            |
