# Quickstart: Yiji CRM (local development)

## Prerequisites
- **Node.js 20+**, **pnpm 9+**, **Docker + Docker Compose**

## First-time setup
```bash
pnpm install                      # install all workspace deps
cp .env.example .env              # populate secrets (see reference below)
docker compose up -d              # directus + postgres + redis + socket-gateway + workers + ai-gateway
pnpm --filter directus-bootstrap apply   # apply schema snapshot + seed roles/service accounts
```
Wait for Directus health, then sign in at http://localhost:8055 with the dev owner credentials.

## Run the frontends (each in its own terminal)
```bash
pnpm --filter agent-portal dev    # http://localhost:5173
pnpm --filter admin-portal dev    # http://localhost:5174
pnpm --filter chat-widget dev     # demo host page with a test Yiji JWT
```

## Environment variable reference (essentials)
| Var | Purpose |
|---|---|
| `DIRECTUS_ADMIN_EMAIL` / `DIRECTUS_ADMIN_PASSWORD` | dev owner (weak by design — **override in prod**) |
| `DIRECTUS_KEY` / `DIRECTUS_SECRET` | generated Directus secrets |
| `DB_*` | Postgres connection |
| `REDIS_URL` | Redis (adapter + queues + cache) |
| `YIJI_JWT_SECRET` | customer token verification (HS256; RS256 key-ready) |
| `SVC_GATEWAY_TOKEN` / `SVC_WORKERS_TOKEN` / `SVC_AI_TOKEN` | Directus service-account tokens |
| `GEMINI_API_KEY` | AI provider (behind `AIProvider` interface) |
| `SMTP_*` | email transport (behind `MailTransport`) |
| `YIJI_API_URL` / `YIJI_API_KEY` | unset → mock client; set → real Yiji integration |
| `STORAGE_*` | local FS or S3-compatible file storage |

## Re-apply schema snapshot
```bash
pnpm --filter directus-bootstrap apply        # re-applies directus/snapshot/
```
Commit a fresh snapshot after any schema change (`directus schema snapshot`).

## Reset local state
```bash
docker compose down -v            # drops volumes (Postgres + Redis data)
docker compose up -d && pnpm --filter directus-bootstrap apply
```

## Quality gates (also run in CI on every push)
```bash
pnpm lint && pnpm typecheck && pnpm test     # ESLint/Prettier, tsc --strict, Vitest
pnpm test:e2e                                 # Playwright across portals + widget
```

## Smoke test (maps to acceptance criteria)
1. Sign an agent into the Agent Portal; confirm the inbox loads (US1).
2. Open the widget demo with a valid test JWT; send a message; confirm it appears in the agent inbox and the agent reply appears in the widget in realtime (US2, SC-002).
3. In Admin Portal create an SLA policy; create a ticket at a matching priority; confirm due dates compute and (with short thresholds) a warning + breach event and notifications fire (US4, SC-004).
4. Invoke an AI feature on a conversation containing PII; inspect the outbound payload — all PII redacted (US5, SC-005).
5. Run two socket-gateway instances; confirm messages route across instances (SC-010).
