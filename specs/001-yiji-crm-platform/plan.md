# Implementation Plan: Yiji CRM — Centralized Internal Support & CRM Platform

**Branch**: `001-yiji-crm-platform` | **Date**: 2026-05-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-yiji-crm-platform/spec.md`

## Summary

Yiji CRM is an internal, multi-vendor customer-support platform: support agents and admins work through two custom React portals; customers reach support only through an embeddable chat widget authenticated by Yiji-signed JWTs. The system of record is **Directus** (Postgres-backed) which provides all CRUD, staff auth, and admin-managed configuration. Realtime chat runs through a horizontally scalable **Socket.IO gateway** (Redis adapter); asynchronous work (SLA timers, notifications, automation, AI jobs, imports, scheduled reports) runs in **BullMQ workers**; AI features route through a dedicated **AI gateway** that redacts PII before calling **Gemini** behind a swappable provider interface. The codebase is a **pnpm monorepo** with TypeScript strict everywhere and a shared-types package preventing drift. Delivery is phased (6 phases) matching the prioritized user stories; each phase is independently deployable.

## Technical Context

**Language/Version**: TypeScript 5.x (strict mode) on Node.js 20 LTS across all services and apps.

**Primary Dependencies**:
- Backend system of record: **Directus** (latest stable) on **PostgreSQL 16**.
- Realtime: **Socket.IO 4** with **@socket.io/redis-adapter** on **Redis 7**.
- Queues: **BullMQ** on Redis 7.
- AI: **Gemini** via `@google/generative-ai`, wrapped behind an internal `AIProvider` interface.
- Frontends: **React 18 + Vite + TypeScript**, **TailwindCSS**, **TanStack Query**, **React Hook Form + Zod**, **i18next** (EN/AR, RTL).
- Widget: **Preact + Vite** (small bundle), Socket.IO client, i18next.
- HTTP services (socket-gateway, ai-gateway): **Fastify** + **pino** logging.
- Validation/shared contracts: **Zod** schemas in `packages/shared-types`.
- Email: **Nodemailer** behind a `MailTransport` interface (SMTP default).
- File storage: Directus storage drivers (local / S3-compatible) configured by env.

**Storage**: PostgreSQL 16 (managed exclusively through Directus collections); Redis 7 for pub/sub + queues + AI response cache. File storage local FS or S3-compatible via env.

**Testing**: **Vitest** for unit/integration in every package/service; **Playwright** for E2E across agent-portal, admin-portal, and widget. CI runs lint + typecheck + unit + E2E on every push.

**Target Platform**: Linux containers (Docker Compose for dev; container-deployable for prod, host-agnostic). Frontends served as static bundles; widget servable from a CDN.

**Project Type**: Web — pnpm monorepo with multiple frontend apps + multiple backend Node services + Directus backend.

**Performance Goals**: Realtime message delivery < 500 ms p95; Agent Portal initial load < 2 s on broadband; chat widget bundle < 50 KB gzipped (target).

**Constraints**: TypeScript strict everywhere; shared types so FE/BE cannot drift; stateless horizontally scalable socket-gateway + workers via Redis; append-only ticket_events (enforced by Directus role permissions); PII redaction before any external AI call; secrets only via env; HTTPS-only + per-env CORS in prod; BullMQ retries + dead-letter + graceful shutdown; structured logging + health checks on all Node services.

**Scale/Scope**: Multi-vendor (vendors as data); internal support team (tens–low hundreds of agents); 17 collections; 3 frontend apps; 3 Node services; 6 BullMQ queues; 7 AI endpoints; 6 delivery phases; bilingual EN/AR.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution at `.specify/memory/constitution.md` is an **unratified template** (all placeholder tokens). No project-specific principles or gates are defined, so there are no constitutional constraints to violate. Default engineering gates applied in lieu of a ratified constitution:

- **Interface-first for external dependencies** — Gemini, SMTP, Yiji platform, file storage each behind an interface (per spec FR-022, FR-024, Approach Notes). ✅ Honored in design.
- **Type safety / no drift** — shared-types package + Zod, strict TS. ✅
- **Test discipline** — Vitest + Playwright in CI. ✅
- **Simplicity / no scope creep** — no features beyond spec Section 11; ask before adding. ✅

**Result**: PASS (no ratified gates; defaults satisfied). Re-evaluated post-design — still PASS.

> Recommendation (non-blocking): run `/speckit-constitution` to ratify principles before heavy implementation so future plans have real gates.

## Project Structure

### Documentation (this feature)

```text
specs/001-yiji-crm-platform/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── README.md
│   ├── socket-gateway.events.md
│   ├── ai-gateway.openapi.yaml
│   ├── yiji-client.interface.md
│   ├── directus-collections.md
│   └── queues.md
├── checklists/
│   └── requirements.md  # (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
yiji-crm/                              # monorepo root (this repo)
├── apps/
│   ├── agent-portal/                  # React 18 + Vite + TS — inbox, conversations, tickets, AI, profiles
│   │   ├── src/{components,pages,features,hooks,lib,i18n}/
│   │   └── tests/                     # Vitest + Playwright
│   ├── admin-portal/                  # React 18 + Vite + TS — users, teams, SLA, automation, custom fields, reports, vendors
│   │   ├── src/{components,pages,features,hooks,lib,i18n}/
│   │   └── tests/
│   └── chat-widget/                   # Preact + Vite — embeddable, JWT init, realtime, RTL, CSAT
│       ├── src/{ui,socket,i18n}/
│       └── tests/
├── services/
│   ├── socket-gateway/                # Fastify + Socket.IO + Redis adapter
│   │   ├── src/{auth,rooms,events,directus,queue,health}/
│   │   └── tests/
│   ├── workers/                       # BullMQ workers: sla, notifications, ai, automation, imports, reports
│   │   ├── src/{queues,processors,directus,mail,health}/
│   │   └── tests/
│   └── ai-gateway/                    # Fastify HTTP — 7 AI endpoints, PII redaction, rate limit, cache
│       ├── src/{routes,redaction,provider,cache,ratelimit,health}/
│       └── tests/
├── packages/
│   ├── shared-types/                  # TS types + Zod schemas + YijiClient interface (source of truth)
│   ├── shared-config/                 # env parsing/validation helpers
│   └── ui/                            # shared React UI components (optional)
├── directus/
│   ├── snapshot/                      # version-controlled schema + roles snapshot
│   ├── extensions/                    # custom hooks/endpoints if needed
│   └── bootstrap/                     # scripts to apply snapshot + seed roles/service accounts
├── docker-compose.yml                 # full dev stack: directus, postgres, redis, socket-gateway, workers, ai-gateway
├── pnpm-workspace.yaml
├── package.json                       # root scripts: lint, typecheck, test, dev
├── tsconfig.base.json
├── .eslintrc / .prettierrc
└── README.md
```

**Structure Decision**: pnpm-workspace monorepo (the spec's Section 4 layout is non-negotiable and adopted verbatim). Three frontend apps under `apps/`, three Node services under `services/`, shared code under `packages/` (with `shared-types` as the single source of truth for cross-boundary contracts), and Directus configuration/snapshot under `directus/`. A single root `docker-compose.yml` brings up the backend stack; frontends run via `pnpm dev`.

## Complexity Tracking

No constitution gate violations to justify. The multi-service / multi-app structure is mandated by the specification (non-negotiable stack and monorepo layout), not introduced by this plan, so it does not constitute unjustified complexity.
