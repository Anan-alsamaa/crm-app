# Yiji CRM — Architecture (as built)

This describes the system as it is actually implemented today, not the original
spec aspirations. For end-user walkthroughs see the
[agent guide](./USER_GUIDE_AGENT.md) and [admin guide](./USER_GUIDE_ADMIN.md);
for deployment see [PRODUCTION.md](./PRODUCTION.md).

## What it is

Yiji CRM is an operator-facing customer-support platform. Agents and admins use
two React portals; customers reach support through an embeddable chat widget
authenticated by a Yiji-signed JWT. Directus is the system of record; three
small Node services provide realtime chat, background processing, and an AI
gateway. Everything is a pnpm/TypeScript monorepo.

## Component map

```
                         ┌────────────────────────┐
   Customer host page    │  chat-widget (Preact)   │
   (Yiji-signed JWT) ───▶│  embeddable bundle      │
                         └───────────┬─────────────┘
                                     │ Socket.IO (customer JWT)
                                     ▼
 ┌───────────────┐  WS    ┌────────────────────────┐  BullMQ jobs   ┌───────────────┐
 │ agent-portal  │◀──────▶│   socket-gateway        │──────────────▶│   workers     │
 │ (React/Vite)  │  REST  │   Fastify + Socket.IO   │   (Redis)     │  BullMQ procs │
 └──────┬────────┘        └───────────┬─────────────┘               └──────┬────────┘
        │ REST (SDK)                  │ writes (service token)              │ reads/writes
        │                             ▼                                     ▼
 ┌──────┴────────┐         ┌────────────────────────┐  ◀──────────  ┌───────────────┐
 │ admin-portal  │────────▶│   Directus 11 (REST)    │               │  ai-gateway   │
 │ (React/Vite)  │  REST   │   Postgres + Redis      │◀─────────────▶│  Fastify      │──▶ Gemini
 └───────────────┘         └────────────────────────┘   reads        └───────────────┘   (swappable)
```

### Frontends (`apps/`)

| App            | Stack                                            | Port (dev) | Talks to                                                |
| -------------- | ------------------------------------------------ | ---------- | ------------------------------------------------------- |
| `agent-portal` | React 18, Vite, TanStack Query, RHF+Zod, i18next | 5173       | Directus (SDK), socket-gateway (WS), ai-gateway (fetch) |
| `admin-portal` | React 18, Vite, TanStack Query, RHF+Zod, i18next | 5174       | Directus (SDK), ai-gateway (admin config)               |
| `chat-widget`  | Preact, Vite (embeddable bundle)                 | 5175       | socket-gateway (WS) only                                |

Auth in the portals is Directus session auth via `@yiji/shared-config`'s auth
client; route guards (`ProtectedRoute`) gate by Directus role. Both portals
ship EN + AR (RTL) translations.

### Services (`services/`)

All three are stateless Node services and scale horizontally; shared state lives
in Redis and Directus.

- **socket-gateway** (Fastify + Socket.IO). The realtime hub and the **sole
  writer of chat messages**. Authenticates customers (HS256 Yiji JWT, verifier
  wrapped for an RS256 swap) and agents (Directus token → `/users/me`). On
  connect it onboards the customer: resolve vendor → dedup/create contact →
  resume/create conversation, then emits `ready`. Handles message/note/typing/
  read/subscribe events, agent presence (with a reconnect grace window), and
  emits BullMQ side-effect jobs. With `REDIS_ENABLED=true` it uses the Redis
  adapter for cross-instance fan-out; with it false it runs single-instance for
  local dev. Socket on `:PORT` (8080), health/ready/debug on `:PORT+1` (8081 in
  CI, but note compose maps ai-gateway to 8081 — health is `PORT+1` relative to
  the gateway).
- **workers** (BullMQ). One processor per queue (see below). Reads/writes
  Directus via a service token; sends email via a pluggable `MailTransport`
  (SMTP in prod, a logging no-op when `SMTP_HOST` is unset).
- **ai-gateway** (Fastify). Seven AI endpoints plus admin config/usage. Each
  request: auth (service token + caller headers) → feature toggle → per-user &
  global sliding-window rate limit + monthly cap → response cache → PII
  redaction → provider (`GeminiProvider`, swappable) → typed parse. Reads
  conversation context from Directus; never writes. Port 8081.

### Backing stores

- **Directus 11** — system of record (the spec's 17 collections: vendors,
  contacts, conversations, messages, tickets, teams, SLA policies, automations,
  reports, custom fields, notifications, …). Schema + roles + service-account
  tokens are applied idempotently by `directus/bootstrap`.
- **Postgres 16** — Directus' database.
- **Redis 7** — three roles: Socket.IO adapter (multi-instance fan-out), BullMQ
  queue backbone, and the ai-gateway's response cache + rate-limit counters.

## Realtime contract (socket events)

Defined in `@yiji/shared-types` (`SOCKET_EVENTS`) and validated with Zod on the
gateway. Client→server: `message:send`, `note:add`, `note:delete`,
`agent:logout`, `typing:start/stop`, `read:ack`, `csat:submit`,
`conversation:subscribe`, `conversation:updated`. Server→client: `message:new`,
`note:new`, `note:deleted`, `typing:update`, `inbox:activity`,
`conversation:changed`, `presence:update`, `agents:presence`,
`notification:pushed`, `error`, plus the per-connection `ready` frame.

Rooms namespace delivery: `conversation:<id>`, `agent:<id>`, `agents:all`,
`vendor:<id>`.

## Background queues (BullMQ)

Six queues, each with a dedicated processor (`services/workers/src/processors`):

| Queue           | Trigger                               | Does                                                                                       |
| --------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sla`           | ticket lifecycle + periodic reconcile | computes first-response/resolution deadlines, emits warnings/breaches, schedules re-checks |
| `notifications` | mentions, assignments, SLA events     | writes in-app notifications + emails per user preferences                                  |
| `ai`            | conversation close / manual           | calls ai-gateway `summarize` / `score_lead`, persists results on the conversation          |
| `automation`    | conversation/message/ticket events    | runs admin-defined rules (depth-guarded against loops)                                     |
| `imports`       | admin CSV upload                      | streams CSV, maps columns, per-vendor contact dedup + upsert                               |
| `reports`       | scheduled / manual                    | aggregates (4 implemented report types), renders CSV, optionally emails                    |

Job options: 5 attempts, exponential backoff, failed jobs retained for
inspection (dead-letter via the failed state).

## AI gateway endpoints

`/summarize-conversation`, `/suggest-reply`, `/analyze-sentiment`,
`/detect-intent`, `/extract-entities`, `/semantic-search`, `/score-lead`, plus
`GET/PUT /admin/config` and `GET /admin/usage`. Outbound prompts are PII-redacted
before they reach the provider. The provider is behind a one-method `AIProvider`
interface, so swapping Gemini for another model is a single file + config flag.

## Stateful vs stateless / required vs optional

- **Stateful:** Postgres (Directus data), Redis (queues, cache, adapter,
  rate-limit counters), Directus uploads volume.
- **Stateless (scale horizontally):** socket-gateway, workers, ai-gateway, and
  the static portal bundles.
- **Required in prod:** Directus, Postgres, Redis, socket-gateway, workers.
- **Optional / degrades cleanly:** ai-gateway (without `GEMINI_API_KEY` the
  endpoints return a clean `not_configured` 503); SMTP (falls back to a logging
  no-op); the Yiji platform client (mock until `YIJI_API_URL` is set).

## Chat-widget embed contract

The host page mints a short-lived HS256 JWT (signed with `YIJI_JWT_SECRET`)
carrying `vendor_id`, `customer_id`, and at least one of `phone`/`email`. The
widget connects to the gateway with `{ kind: 'customer', token }`. The gateway
verifies the signature, resolves the vendor (must be `active`), dedups the
contact, resumes/creates the open conversation, and returns branding + the
current agent-online count in the `ready` frame. Query params are never trusted.

## Source layout

```
apps/{agent-portal,admin-portal,chat-widget}
packages/{shared-types,shared-config,ui,i18n}
services/{socket-gateway,workers,ai-gateway}
directus/{bootstrap,local,extensions,snapshot}
```

`@yiji/shared-types` holds the Zod schemas + event/endpoint/queue constants that
every layer imports, so the contracts can't drift between client and server.
