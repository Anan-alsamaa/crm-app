# YIJI CRM

Centralized internal customer-support & CRM platform for the Yiji ecosystem.
Operator-facing only (agents + admins); customers reach support through an
embeddable chat widget authenticated by a Yiji-signed JWT.

## What's in the box

```
crm-app/
├── apps/
│   ├── agent-portal/        # React 18 + Vite — inbox, conversations,
│   │                        # tickets, contacts, AI panel, preferences
│   ├── admin-portal/        # React 18 + Vite — users, teams, SLA,
│   │                        # vendors, automation, reports, custom
│   │                        # fields, imports, AI config
│   └── chat-widget/         # Preact + Vite — embeddable customer widget
├── packages/
│   ├── shared-types/        # Zod schemas + YijiClient (mock + HTTP)
│   ├── shared-config/       # env parsing, Directus client, auth
│   └── ui/                  # @yiji/ui — primitives + tokens + tailwind
├── services/
│   ├── socket-gateway/      # Fastify + Socket.IO (Redis adapter)
│   ├── workers/             # BullMQ workers — SLA, notifications, AI,
│   │                        # automation, imports, reports
│   └── ai-gateway/          # Fastify — 7 AI endpoints, PII redaction,
│                            # rate limit, monthly cap, response cache
├── directus/                # Directus 11 — system of record (17 collections)
│   ├── bootstrap/           # Schema + roles + service tokens applier
│   └── local/               # Local SQLite dev instance (no Docker)
└── specs/001-yiji-crm-platform/
    ├── spec.md / plan.md / tasks.md
    ├── research.md / data-model.md / quickstart.md
    └── contracts/           # YijiClient / socket events / AI / queues
```

## Prerequisites

| Tool       | Version        | Notes                                                     |
| ---------- | -------------- | --------------------------------------------------------- |
| Node.js    | 20 LTS         | `nvm install 20` recommended                              |
| pnpm       | 9.x            | `corepack enable && corepack prepare pnpm@9 --activate`   |
| PostgreSQL | 16             | Or use the docker-compose stack                           |
| Redis      | 7              | Required for prod; dev can run with `REDIS_ENABLED=false` |
| Docker     | 24+ (optional) | For `docker-compose.yml`                                  |

## Quick start — local SQLite (no Docker)

The simplest path for one-machine dev. Uses Directus on SQLite, no Postgres
or Redis required (the socket-gateway runs in single-instance mode).

```bash
# 1. Install
pnpm install

# 2. Bootstrap the local Directus instance
cd directus/local
cp ../../.env.example .env       # then edit DIRECTUS_ADMIN_* + secrets
npm install
npm run bootstrap
npm run start                    # serves on :8055
cd ../..

# 3. Start the agent + admin portals (in another terminal)
pnpm --filter @yiji/agent-portal dev   # :5173
pnpm --filter @yiji/admin-portal dev   # :5174

# 4. (Optional) Start the chat-widget demo page
pnpm --filter @yiji/chat-widget dev    # :5175

# 5. (Optional) Start the socket-gateway in single-instance mode
REDIS_ENABLED=false \
YIJI_JWT_SECRET=dev-yiji-secret \
SVC_GATEWAY_TOKEN=dev-gateway-token \
PORT=8080 \
pnpm --filter @yiji/socket-gateway dev
```

Sign in at <http://localhost:5174/login> with the `DIRECTUS_ADMIN_*` credentials
from your `.env`.

## Quick start — full stack via docker-compose

```bash
cp .env.example .env             # edit secrets + admin creds
docker compose --profile app up  # FULL stack: postgres, redis, directus, gateway, workers, ai-gateway
                                 # (omit `--profile app` for INFRA ONLY — the hybrid
                                 #  setup where PM2 runs the app tier; see start-infra.ps1)
pnpm install
pnpm --filter @yiji/agent-portal dev
pnpm --filter @yiji/admin-portal dev
```

## Environment reference

See [.env.example](./.env.example) for the full list. The values fall into
five groups:

- **Directus + Postgres** — backing system of record + auth.
- **Redis** — Socket.IO adapter (multi-instance), BullMQ queues, AI cache + rate limit.
- **Customer JWT** — `YIJI_JWT_SECRET` (HS256). `YIJI_JWT_PUBLIC_KEY` reserved
  for RS256 swap; the verifier is wrapped so the swap is a one-place change.
- **Service-account static tokens** — `SVC_GATEWAY_TOKEN`, `SVC_WORKERS_TOKEN`,
  `SVC_AI_TOKEN`. Seeded into Directus at bootstrap; loaded by each service
  at boot.
- **AI / SMTP / Yiji platform / storage** — optional integrations; each has
  a no-op fallback so the system runs without them.

### ⚠️ Weak dev credentials

`DIRECTUS_ADMIN_PASSWORD=123456` and `dev-yiji-secret` in `.env.example` are
**intentionally weak** for fast onboarding. **Production must override them**
via the environment with strong secrets. The dev secret also matches the
chat-widget demo page so end-to-end auth works out of the box; rotating in
prod requires updating both the gateway env AND the host page's JWT issuer.

## Workspace scripts

```bash
pnpm lint           # eslint . --ext .ts,.tsx
pnpm typecheck      # tsc --noEmit across all packages
pnpm test           # vitest run (unit/integration)
pnpm test:e2e       # playwright test (E2E)
pnpm format         # prettier --write
pnpm build          # build every package that has a build script
pnpm dev            # start every package's dev script in parallel
```

Each app/service also exposes its own `dev`, `start`, `typecheck`, and `test`
where applicable — run them via `pnpm --filter @yiji/<package> <script>`.

## Re-applying the Directus schema

The 17-collection schema is defined in `directus/bootstrap/` and exported as
a snapshot under `directus/snapshot/`. To re-apply (e.g. after a hostile
edit to Directus' admin UI):

```bash
cd directus/local && npm run bootstrap
```

This idempotently applies collections, fields, relations, roles, and the
service-account tokens from `.env`.

## Resetting local data

```bash
# Local SQLite dev:
rm directus/local/data.db
cd directus/local && npm run bootstrap && npm run start

# Docker stack:
docker compose down -v   # removes the postgres + redis volumes
```

## Testing

- **Unit / integration**: `pnpm test` runs every `*.test.ts` / `*.spec.ts`
  under `packages/**` and `services/**`, then each app's own jsdom-based suite.
- **Coverage**: `pnpm test:coverage` runs the services/packages suite with v8
  coverage; each app reports its own. CI **enforces** line thresholds
  (services ≥70%, apps gated by their `vitest.config.ts`) and fails on
  regression. Coverage is uploaded as a CI artifact and summarized on each run.
- **E2E**: `pnpm test:e2e` — Playwright across agent / admin / widget (the
  full-stack suite runs in CI on the integration branch). To run it locally
  **safely**, use `pnpm test:e2e:local`: it spins up a throwaway SQLite Directus
  on `:8066`, applies the schema, starts the gateway + portals + widget against
  it, runs Playwright, then tears everything down — so it **never touches the
  demo database**. Prereq: stop your demo dev servers first (the specs use
  ports 5173–5175 / 8080).
- **Pre-commit**: husky + lint-staged run `eslint --fix` + `prettier` on staged
  files (no test suite) so format/lint drift never lands. Installed via
  `pnpm install` (the `prepare` script).

CI runs the `quality` (lint/typecheck/unit+coverage) and `e2e` jobs in
parallel; Playwright browsers and the pnpm store are cached.

## Component library (Storybook)

The `@yiji/ui` primitives have a Storybook (design tokens + Tailwind preset
wired in):

```bash
pnpm --filter @yiji/ui storybook        # dev server on :6006
pnpm --filter @yiji/ui build-storybook  # static build → packages/ui/storybook-static
```

## Production checklist

See [docs/PRODUCTION.md](./docs/PRODUCTION.md) for a full deploy guide.
Highlights:

- Override every `replace-with-*` secret in `.env.example`.
- Override `DIRECTUS_ADMIN_PASSWORD`; do not ship `123456`.
- Set `CORS_ORIGIN` to your portal hostnames on every Node service.
- Set `REDIS_URL` to a real Redis 7+ instance (not the dev fallback).
- Configure a real `SMTP_*` transport.
- Set `GEMINI_API_KEY` if AI features should be live (otherwise the
  endpoints return a clean `not_configured` 503).
- Set `YIJI_API_URL` to switch the YijiClient from mock to HTTP.
- Run behind HTTPS; rely on the gateway CORS allow-list.
- Scale `socket-gateway` and `workers` horizontally — both are stateless
  and coordinate via Redis.

## Documentation

- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — the as-built system:
  components, realtime contract, queues, AI endpoints, what's stateful vs
  stateless, the widget embed contract.
- **[docs/USER_GUIDE_AGENT.md](./docs/USER_GUIDE_AGENT.md)** — using the agent
  portal: inbox, conversations, notes, AI panel, tickets, notifications.
- **[docs/USER_GUIDE_ADMIN.md](./docs/USER_GUIDE_ADMIN.md)** — configuration:
  users, teams, vendors, SLA, automation, reports, custom fields, imports, AI.
- **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** — opinionated step-by-step deploy
  guide (single-host Docker Compose + auto-TLS), rollback, upgrades, scaling.
- **[docs/PRODUCTION.md](./docs/PRODUCTION.md)** — deployment runbook (full reference).
- **[docs/AUDITS.md](./docs/AUDITS.md)** — pre-release audit runbook: accessibility
  (WCAG), performance, horizontal scaling, and the quickstart smoke test.

The original design artifacts (spec, data model, contracts) live under
[specs/001-yiji-crm-platform/](./specs/001-yiji-crm-platform/) for historical
reference; the docs above describe what actually shipped.

## License

Internal.
