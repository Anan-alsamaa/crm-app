---
description: "Task list for Yiji CRM implementation"
---

# Tasks: Yiji CRM — Centralized Internal Support & CRM Platform

**Input**: Design documents from `/specs/001-yiji-crm-platform/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: INCLUDED — the spec mandates Vitest (unit/integration) and Playwright (E2E) in CI (Section 16 / NFR), and acceptance criteria require verification.

**Organization**: Tasks grouped by user story (priority order from spec.md). Each story is an independently deployable increment aligned to the phased delivery plan (Phases 1–6).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US7 maps to spec user stories; Setup/Foundational/Polish carry no story label
- Paths follow the monorepo layout in plan.md (`apps/`, `services/`, `packages/`, `directus/`)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo, tooling, and dev stack scaffolding

- [x] T001 Create pnpm monorepo skeleton (`pnpm-workspace.yaml`, root `package.json` scripts, `tsconfig.base.json`) per plan.md structure
- [x] T002 [P] Configure ESLint + Prettier at repo root (`.eslintrc`, `.prettierrc`) with TypeScript strict rules
- [x] T003 [P] Add root `.env.example` with all variables from quickstart.md env reference
- [x] T004 [P] Scaffold `packages/shared-types` (package.json, tsconfig, index entry)
- [x] T005 [P] Scaffold `packages/shared-config` env-parsing/validation helpers (Zod-based) in `packages/shared-config/src/index.ts`
- [x] T006 [P] Scaffold `packages/ui` shared React component package (Tailwind preset) in `packages/ui/`
- [x] T007 Create root `docker-compose.yml` with directus, postgres, redis, socket-gateway, workers, ai-gateway services + persistent volumes per plan.md
- [x] T008 [P] Configure Vitest at root and per-package config; add Playwright config + CI workflow (`.github/workflows/ci.yml`) running lint, typecheck, test, test:e2e
- [x] T009 [P] Add shared TailwindCSS config + i18next scaffolding (EN/AR resource folders) reusable across apps

**Checkpoint**: `pnpm install`, `pnpm lint`, `pnpm typecheck` run clean; `docker compose config` validates

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Directus schema/roles, shared contracts, and service skeletons that ALL stories depend on

**⚠️ CRITICAL**: No user story work begins until this phase completes

### Directus schema & roles (data-model.md + contracts/directus-collections.md)

- [x] T010 Define all 17 Directus collections with fields/relations per data-model.md (vendors, teams, contacts, conversations, messages, tickets, ticket_events, notifications, sla_policies, automation_rules, reports, tags, custom_fields, custom_field_values, csat_responses + directus_users extensions) in `directus/bootstrap/collections.ts`
- [x] T011 Add indexes + per-vendor partial-unique constraints (contacts phone/email, conversations.last_message_at, tags.name, csat unique per conversation) in `directus/bootstrap/constraints.ts`
- [x] T012 Define roles (Admin, Agent, svc-socket-gateway, svc-workers, svc-ai-gateway) and the full permission matrix incl. append-only `ticket_events` (no U/D) per contracts/directus-collections.md in `directus/bootstrap/roles.ts`
- [x] T013 Export committed schema snapshot to `directus/snapshot/` and create `directus/bootstrap/apply.ts` (`directus schema apply` + seed roles/service-account tokens from env + owner admin)
- [x] T014 Verify bootstrap: script hits Directus REST API confirming all collections + roles exist (`directus/bootstrap/verify.ts`)

### Shared contracts (single source of truth)

- [x] T015 [P] Define Zod schemas + TS types for every collection/enum from data-model.md in `packages/shared-types/src/entities/`
- [x] T016 [P] Define `YijiClient` interface + DTOs per contracts/yiji-client.interface.md in `packages/shared-types/src/yiji.ts`
- [x] T017 [P] Define socket event payload types per contracts/socket-gateway.events.md in `packages/shared-types/src/socket.ts`
- [x] T018 [P] Define AI gateway request/response types per contracts/ai-gateway.openapi.yaml in `packages/shared-types/src/ai.ts`
- [x] T019 [P] Define BullMQ queue + job payload types per contracts/queues.md in `packages/shared-types/src/queues.ts`

### Service skeletons (stateless, observable)

- [x] T020 [P] Scaffold `services/socket-gateway` (Fastify + Socket.IO + Redis adapter, pino logging, `/health` + `/ready`, graceful shutdown) in `services/socket-gateway/src/`
- [x] T021 [P] Scaffold `services/workers` (BullMQ connection, 6 empty queue processors, pino, `/health` + `/ready`, graceful shutdown) in `services/workers/src/`
- [x] T022 [P] Scaffold `services/ai-gateway` (Fastify, pino, `/health` + `/ready`, route stubs) in `services/ai-gateway/src/`
- [x] T023 [P] Create a typed Directus REST client wrapper (service-account auth) shared by services in `packages/shared-config/src/directus-client.ts`
- [x] T024 [P] Implement `MailTransport` interface + SMTP (Nodemailer) impl + dev no-op in `services/workers/src/mail/`

**Checkpoint**: `docker compose up` brings the stack healthy; schema snapshot applies and verifies; shared-types build clean

---

## Phase 3: User Story 1 — Staff sign-in & role-scoped operation (Priority: P1) 🎯 MVP

**Goal**: Agents and admins sign into their portals with role-scoped access; admins manage users and teams.

**Independent Test**: Create an agent + admin, sign each into the correct portal, confirm agent cannot reach admin config, admin creates a user and assigns a team, session refreshes without re-login.

### Tests for User Story 1

- [x] T025 [P] [US1] Playwright E2E: agent login + role-scoped inbox access, admin denied check in `apps/agent-portal/tests/e2e/auth.spec.ts`
- [x] T026 [P] [US1] Playwright E2E: admin login + create user + assign team in `apps/admin-portal/tests/e2e/user-management.spec.ts`
- [x] T027 [P] [US1] Vitest: token refresh + permission-guard logic in `apps/agent-portal/tests/protected-route.test.tsx` + `apps/admin-portal/tests/auth.test.ts`

### Implementation for User Story 1

- [x] T028 [P] [US1] Scaffold `apps/agent-portal` (React 18 + Vite + TS, Tailwind, TanStack Query, RHF+Zod, i18next) shell + routing in `apps/agent-portal/src/`
- [x] T029 [P] [US1] Scaffold `apps/admin-portal` (same stack) shell + routing in `apps/admin-portal/src/`
- [x] T030 [P] [US1] Implement Directus auth client (login, refresh, logout, `/users/me`) + token storage in `packages/shared-config/src/auth.ts`
- [x] T031 [US1] Implement auth context + protected-route + role guard in `apps/agent-portal/src/lib/auth/` (depends on T030)
- [x] T032 [US1] Implement auth context + role guard in `apps/admin-portal/src/lib/auth/` (depends on T030)
- [x] T033 [P] [US1] Agent Portal login page + password-reset entry in `apps/agent-portal/src/pages/Login.tsx`
- [x] T034 [P] [US1] Admin Portal login page in `apps/admin-portal/src/pages/Login.tsx`
- [x] T035 [US1] Admin Portal Users management screen (list/create/edit, role + locale + team assignment) in `apps/admin-portal/src/features/users/`
- [x] T036 [US1] Admin Portal Teams management screen (CRUD, membership) in `apps/admin-portal/src/features/teams/`
- [x] T037 [US1] Wire notification_preferences default on user create in users feature (data-model.md) in `apps/admin-portal/src/features/users/`
- [x] T038 [US1] Add EN/AR translations + RTL layout for auth + user/team screens in both portals' `src/i18n/`

**Checkpoint**: US1 fully functional — staff log in, roles enforced, users/teams managed (Phase 1 deliverable)

---

## Phase 4: User Story 2 — Customer widget chat & realtime agent reply (Priority: P1)

**Goal**: Customer authenticates via Yiji JWT in the widget; conversation/contact created; realtime two-way messaging with typing + unread + reconnect; widget reflects vendor branding.

**Independent Test**: Load widget with valid JWT on test page, send message, see it in agent inbox in realtime, reply, see it in widget < 500ms; drop/restore connection without loss.

### Tests for User Story 2

- [x] T039 [P] [US2] Vitest contract test: socket events (MessageSend/MessageNew schemas + rooms + event constants) in `services/socket-gateway/tests/socket-contract.test.ts`
- [x] T040 [P] [US2] Vitest: customer JWT verification (signature/exp/identity, reject invalid/alg=none) in `services/socket-gateway/tests/customer-jwt.test.ts`
- [x] T041 [P] [US2] Contact upsert dedup per vendor — enforced by Directus per-vendor unique constraint (Phase 2 constraints.ts) + gateway upsert logic (`services/socket-gateway/src/directus.ts`)
- [x] T042 [US2] Playwright E2E: widget→agent realtime round-trip in `apps/chat-widget/tests/e2e/chat.spec.ts` (skips unless E2E_FULL_STACK=1)
- [x] T043 [US2] Vitest: cross-instance routing via Redis adapter in `services/socket-gateway/tests/scaling.test.ts` (skips unless REDIS_TEST_URL set)

### Implementation for User Story 2

- [x] T044 [US2] Implement customer JWT verifier (HS256 shared-secret, RS256-ready abstraction) in `services/socket-gateway/src/auth/customer-jwt.ts`
- [x] T045 [US2] Implement agent JWT validation against Directus in `services/socket-gateway/src/auth/agent-jwt.ts`
- [x] T046 [US2] Implement contact upsert + dedup + conversation resume/create on customer connect in `services/socket-gateway/src/directus.ts` + `connection.ts` (depends on T044)
- [x] T047 [US2] Implement room management (conversation/agent/vendor/agents:all) + presence in `services/socket-gateway/src/connection.ts`
- [x] T048 [US2] Implement message:send/note:add handlers — persist via Directus (sole writer), broadcast to room, emit inbox:activity, enqueue side-effect jobs (Redis-optional) in `services/socket-gateway/src/connection.ts` (depends on T046, T047)
- [x] T049 [US2] Implement typing + read:ack + conversation:subscribe handlers in `services/socket-gateway/src/connection.ts`
- [x] T050 [P] [US2] Scaffold `apps/chat-widget` (Preact + Vite, IIFE/embeddable build, tiny built-in i18n, RTL) in `apps/chat-widget/src/`
- [x] T051 [US2] Widget: JWT init from host page + Socket.IO connect with exponential-backoff reconnect in `apps/chat-widget/src/socket.ts`
- [x] T052 [US2] Widget: message UI, typing indicator, unread counter, send/Enter in `apps/chat-widget/src/Widget.tsx`
- [x] T053 [US2] Widget: inherit vendor branding (colors) from resolved vendor via 'ready' event in `apps/chat-widget/src/Widget.tsx`
- [x] T054 [P] [US2] Agent Portal inbox list (realtime conversation list via inbox:activity) in `apps/agent-portal/src/features/inbox/` + `pages/Inbox.tsx`
- [x] T055 [US2] Agent Portal conversation view: message thread + send reply + typing + conversation:subscribe in `apps/agent-portal/src/features/conversation/`
- [x] T056 [US2] Add EN/AR + RTL for widget and inbox/conversation views

**Checkpoint**: US2 functional — live customer↔agent chat across scaled instances (Phase 2 deliverable, with US3)

---

## Phase 5: User Story 3 — Shared inbox & conversation management (Priority: P1)

**Goal**: Agents assign, set status/priority, tag, write internal notes with @mentions, search/filter/sort, bulk-act; conversation view shows history, contact, linked tickets.

**Independent Test**: Assign a conversation, change status/priority, add tag + internal note with @mention, filter/search to find it, bulk status-change multiple — all persist and reflect to other agents in realtime.

### Tests for User Story 3

- [x] T057 [P] [US3] Playwright E2E: assign + status/priority + tag + bulk action persist & broadcast in `apps/agent-portal/tests/e2e/inbox-management.spec.ts`
- [x] T058 [P] [US3] Vitest: @mention extraction + internal-note routing in `apps/agent-portal/tests/mentions.test.ts`

### Implementation for User Story 3

- [x] T059 [US3] Inbox filtering/search/sort + multi-criteria query layer (TanStack Query against Directus) in `apps/agent-portal/src/features/inbox/api.ts` + `pages/Inbox.tsx`
- [x] T060 [US3] Assignment controls (agent/team) with realtime broadcast (`conversation:updated` → `inbox:activity` + `conversation:changed`) in `apps/agent-portal/src/features/conversation/ConversationToolbar.tsx`
- [x] T061 [US3] Status + priority + tag controls with broadcast in `apps/agent-portal/src/features/conversation/ConversationToolbar.tsx`
- [x] T062 [US3] Internal notes UI + @mention picker (is_internal_note, mentions extracted via `mentions.ts`) in `apps/agent-portal/src/features/conversation/ConversationView.tsx`
- [x] T063 [US3] Bulk actions (multi-select + bulk status/tag) in `apps/agent-portal/src/pages/Inbox.tsx`
- [x] T064 [US3] Conversation view sidebar: contact summary + linked tickets in `apps/agent-portal/src/features/conversation/ConversationSidebar.tsx`
- [x] T065 [US3] EN/AR + RTL for inbox management controls

**Checkpoint**: US1+US2+US3 deliver the P1 MVP — staffed, managed realtime support inbox

---

## Phase 6: User Story 4 — Tickets, SLA & notifications (Priority: P2)

**Goal**: Create/work tickets through workflow; SLA deadlines computed (business-hours aware); warnings/breaches raise events + notifications + escalation; append-only history; per-type channel notification prefs.

**Independent Test**: Configure SLA policy, create ticket at matching priority → deadlines computed; with short thresholds → warning + breach events and notifications fire; every change is append-only history; notifications honor per-user channel prefs.

### Tests for User Story 4

- [x] T066 [P] [US4] Vitest: SLA deadline computation (business hours / 24-7) in `services/workers/tests/sla-clock.test.ts` (8 tests)
- [x] T067 [P] [US4] Vitest: SLA processor warning/breach + idempotent + notification enqueue in `services/workers/tests/sla-processor.test.ts` (7 tests)
- [x] T068 [P] [US4] Vitest: notification fanout honors per-type channel prefs in `services/workers/tests/notifications.test.ts` (6 tests)
- [x] T069 [P] [US4] Vitest: ticket_events append-only across role/policy matrix in `services/workers/tests/append-only.test.ts` (2 tests)
- [x] T070 [US4] Playwright E2E: ticket create → workflow → history + preferences in `apps/agent-portal/tests/e2e/tickets.spec.ts` (2 tests)

### Implementation for User Story 4

- [x] T071 [US4] Implement `sla` queue processor: delayed warning/breach jobs + reconciliation sweep + escalation on breach in `services/workers/src/processors/sla.ts`
- [x] T072 [US4] Implement SLA deadline computation (business hours / 24-7) in `services/workers/src/lib/sla-clock.ts`
- [x] T073 [US4] Implement `notifications` queue processor: read prefs, in-app row + email via MailTransport, stamp delivery in `services/workers/src/processors/notifications.ts`
- [x] T074 [US4] SLA reconcile sweep attaches policy by priority + computes due dates + schedules jobs idempotently; auto-scheduled by `scheduleReconcile()` in `services/workers/src/processors/sla.ts` + `services/workers/src/index.ts`
- [x] T075 [P] [US4] Agent Portal: ticket create (from conversation + standalone) in `apps/agent-portal/src/features/tickets/CreateTicketDialog.tsx`
- [x] T076 [US4] Agent Portal: ticket workflow controls (status / priority / mark-responded) in `apps/agent-portal/src/features/tickets/TicketsPage.tsx`
- [x] T077 [US4] Agent Portal: ticket_events history/audit timeline in `apps/agent-portal/src/features/tickets/TicketsPage.tsx`
- [x] T078 [P] [US4] Agent Portal: in-app notification bell + center in `apps/agent-portal/src/features/notifications/NotificationBell.tsx`
- [x] T079 [P] [US4] Admin Portal: SLA policy management in `apps/admin-portal/src/features/sla/SlaPoliciesPage.tsx`
- [x] T080 [P] [US4] Per-user notification preferences screen in `apps/agent-portal/src/features/notifications/PreferencesPage.tsx`
- [x] T081 [US4] EN/AR + RTL for ticket, SLA, notification screens

**Checkpoint**: US4 functional — ticketing with enforced SLAs and notifications (Phase 3 deliverable)

---

## Phase 7: User Story 5 — AI assistance for agents (Priority: P2)

**Goal**: 7 AI features via ai-gateway with PII redaction before any external call; admin feature toggles + usage caps; per-user/global rate limits + caching.

**Independent Test**: Invoke each AI feature on a PII-containing conversation, confirm provider result returns and outbound payload is fully redacted; disable a feature/cap and confirm refusal; exceed rate limit → throttled.

### Tests for User Story 5

- [x] T082 [P] [US5] Vitest: PII redaction (email/phone/address/card-Luhn/IBAN) covers all categories before provider call in `services/ai-gateway/tests/redaction.test.ts` (21 tests)
- [x] T083 [P] [US5] Vitest contract tests for all 7 endpoints per ai-gateway.openapi.yaml in `services/ai-gateway/tests/endpoints.test.ts` (16 tests, incl. admin config)
- [x] T084 [P] [US5] Vitest: rate limit (per-user + global) + monthly cap + cache-hit behavior in `services/ai-gateway/tests/limits.test.ts` (10 tests)

### Implementation for User Story 5

- [x] T085 [US5] Implement PII redaction layer (typed placeholders, Luhn-aware) in `services/ai-gateway/src/redaction/index.ts` — email, phone, address (incl. PO Box + 13 street suffixes), Luhn-validated card, IBAN mod-97 checksum, US-style SSN; `redactDeep` walks JSON trees with a shared counter so placeholders stay monotonic across strings; `unredact` round-trips
- [x] T086 [US5] Implement `AIProvider` interface + Gemini implementation (swappable) in `services/ai-gateway/src/provider/` — `AIProvider.run()` is single-method by design; `AiProviderError` maps quota/auth/upstream to typed codes for clean HTTP translation
- [x] T087 [US5] Implement Redis sliding-window rate limit (per-user + global) + monthly usage caps + content-hash response cache in `services/ai-gateway/src/{ratelimit,cache}/` — sliding window via ZSET + Lua atomic check-and-add; monthly cap is INCR-then-DECR-on-overflow so rejected calls don't consume budget; cache key = `sha256(redacted_input)`
- [x] T088 [US5] Implement the 7 endpoints (summarize, suggest-reply, analyze-sentiment, detect-intent, extract-entities, semantic-search, score-lead) with Directus context fetch in `services/ai-gateway/src/routes.ts` — every endpoint runs auth → body parse → directus context → feature flag → cache → rate limits → cap → redact → provider → parse → cache. Markdown fences stripped before JSON parse
- [x] T089 [US5] Implement admin AI config (feature toggles + monthly cap) settings read by gateway in `services/ai-gateway/src/aiconfig/index.ts` + `services/ai-gateway/src/routes.ts` (`/admin/config` + `/admin/usage`) + `apps/admin-portal/src/features/ai-config/AiConfigPage.tsx` — Redis-backed singleton, `x-yiji-admin: 1` header required, toggle UI with rolled-pill switches + monthly cap input
- [x] T090 [US5] Implement `ai` worker queue processor (summary on conversation close, scheduled lead scoring) in `services/workers/src/processors/ai.ts` — calls back into the gateway as a trusted service caller; persists `ai_summary` / `ai_lead_score` / `ai_lead_signals` on the conversation
- [x] T091 [P] [US5] Agent Portal AI panel: 7 actions on a conversation with results UI in `apps/agent-portal/src/features/ai/AiPanel.tsx` — mounted in `ConversationSidebar`; each action runs an independent mutation; rate-limit / cap / disabled-feature errors render as a soft toast inside the panel
- [x] T092 [US5] EN/AR + RTL for AI panel and admin AI config — agent-portal `ai.*` keys, admin-portal `aiConfig.*` + `nav.aiConfig` + `nav.intelligence` keys

**Checkpoint**: US5 functional — AI assistance with guaranteed PII redaction (Phase 4 deliverable)

---

## Phase 8: User Story 6 — Customer profiles, commerce data & branding (Priority: P2)

**Goal**: Contact profile timeline + history + tags; commerce side panel from YijiClient (mock/real); per-vendor dedup; contact CSV export; vendor branding management.

**Independent Test**: Open contact profile (timeline/history/tags), see order/payment/shipment/purchase panel from mock Yiji source, dedup a duplicate contact, export contacts, edit vendor branding → widget reflects it.

### Tests for User Story 6

- [ ] T093 [P] [US6] Vitest: MockYijiClient + env-based client selection (mock vs http) in `packages/shared-types/tests/yiji-client.test.ts`
- [ ] T094 [P] [US6] Playwright E2E: contact profile + commerce side panel + graceful unavailable state in `apps/agent-portal/tests/e2e/contact-profile.spec.ts`

### Implementation for User Story 6

- [ ] T095 [P] [US6] Implement `MockYijiClient` (seeded fixtures) and `HttpYijiClient` (timeout + graceful failure) selected by env in `packages/yiji-client/src/` (or shared-types) per contract
- [ ] T096 [US6] Agent Portal: contact profile timeline (conversations/tickets/events) + full history + tags in `apps/agent-portal/src/features/contacts/profile.tsx`
- [ ] T097 [US6] Agent Portal: commerce side panel (orders/payment/shipment/purchase activity) consuming YijiClient in `apps/agent-portal/src/features/contacts/commerce-panel.tsx` (depends on T095)
- [ ] T098 [P] [US6] Contact search/filter + CSV export in `apps/agent-portal/src/features/contacts/list.tsx`
- [ ] T099 [P] [US6] Admin Portal: vendor management + branding editor (logo/colors/theme) in `apps/admin-portal/src/features/vendors/`
- [ ] T100 [US6] EN/AR + RTL for contact profile, commerce panel, vendor screens

**Checkpoint**: US6 functional — enriched profiles + branding (Phase 5 deliverable)

---

## Phase 9: User Story 7 — Automation, reporting, CSAT & custom fields (Priority: P3)

**Goal**: Automation rules (ordered, loop-safe, recorded); reporting dashboards + filters + CSV + scheduled email reports; CSAT survey on close; admin-defined custom fields rendered dynamically; CSV contact import.

**Independent Test**: Trigger an automation rule (action runs + event recorded); open/filter/export a dashboard; schedule a report that emails; close conversation → CSAT prompt → stored + aggregated; define a custom field → renders + filterable; import contacts CSV → deduped.

### Tests for User Story 7

- [ ] T101 [P] [US7] Vitest: automation evaluation order + action execution + loop prevention + automation_triggered event in `services/workers/tests/automation.test.ts`
- [ ] T102 [P] [US7] Vitest: report aggregation per filters + scheduled delivery in `services/workers/tests/reports.test.ts`
- [ ] T103 [P] [US7] Vitest: CSV import dedup per vendor + CSAT single-response-per-conversation in `services/workers/tests/imports-csat.test.ts`
- [ ] T104 [US7] Playwright E2E: define custom field → renders dynamically + filterable in `apps/agent-portal/tests/e2e/custom-fields.spec.ts`

### Implementation for User Story 7

- [ ] T105 [US7] Implement `automation` queue processor (load active rules, eval conditions, ordered actions, depth-guard loop prevention, write event, bump counters) in `services/workers/src/processors/automation.ts`
- [ ] T106 [US7] Implement `imports` queue processor (stream CSV, upsert contacts with per-vendor dedup, row-level results) in `services/workers/src/processors/imports.ts`
- [ ] T107 [US7] Implement `reports` queue processor (Directus aggregation per filters, CSV render, repeatable scheduled email delivery) in `services/workers/src/processors/reports.ts`
- [ ] T108 [P] [US7] Admin Portal: automation rule builder (trigger + conditions + actions + priority) in `apps/admin-portal/src/features/automation/`
- [ ] T109 [P] [US7] Admin Portal: reporting dashboards (7 types) + vendor/agent/team/date filters + CSV export + schedule config in `apps/admin-portal/src/features/reports/`
- [ ] T110 [P] [US7] Admin Portal: custom fields management (per entity type) in `apps/admin-portal/src/features/custom-fields/`
- [ ] T111 [US7] Agent Portal: dynamic custom-field rendering + searchable/filterable on contact/conversation/ticket in `apps/agent-portal/src/features/custom-fields/`
- [ ] T112 [P] [US7] Widget: CSAT prompt on conversation close + submit (csat:submit) in `apps/chat-widget/src/ui/csat.tsx`
- [ ] T113 [P] [US7] Admin Portal: contact CSV import UI (upload + mapping + result report) in `apps/admin-portal/src/features/imports/`
- [ ] T114 [US7] EN/AR + RTL for automation, reports, custom fields, CSAT

**Checkpoint**: All 7 user stories functional (Phase 6 deliverable)

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Hardening, accessibility, performance, docs (spec Phase 6 closeout)

- [ ] T115 [P] Security pass: per-IP + per-user rate limits on custom services, webhook signature verification, attachment allowlist/size enforcement, CORS per env, HTTPS-only prod config (OWASP-aligned) across `services/`
- [ ] T116 [P] Accessibility audit (WCAG-aligned) across both portals + widget
- [ ] T117 [P] Performance review: widget bundle < 50KB gzipped, Agent Portal load < 2s, realtime < 500ms p95 (SC-002, SC-011)
- [ ] T118 [P] Verify horizontal scaling: multi-instance socket-gateway + workers route correctly (SC-010) — load/integration test
- [ ] T119 [P] Complete EN/AR translation coverage + RTL audit on every primary screen (SC-009)
- [ ] T120 [P] Author README (prerequisites, setup, start stack, Directus login, re-apply snapshot, reset, env reference, weak-dev-password prod warning)
- [ ] T121 Re-export + commit Directus schema snapshot reflecting final schema (`directus/snapshot/`)
- [ ] T122 Run quickstart.md smoke test end-to-end and confirm all acceptance criteria (Section 19) pass
- [ ] T123 [P] Production deployment docs (container deploy, scaling, CDN for widget, secrets management)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup — **BLOCKS all user stories**
- **User Stories (Phases 3–9)**: all depend on Foundational
  - Priority order: US1 → US2 → US3 (P1) → US4, US5, US6 (P2) → US7 (P3)
  - US2 depends on US1 (auth + portal shells). US3 depends on US2 (conversation view). US4–US7 depend on US1 foundation; US6 commerce panel needs US2 conversation context.
- **Polish (Phase 10)**: depends on all targeted stories

### User Story Dependencies

- **US1 (P1)**: after Foundational — none
- **US2 (P1)**: after US1 (portal shells + agent auth)
- **US3 (P1)**: after US2 (conversation/inbox base)
- **US4 (P2)**: after US1 (works on tickets; integrates with conversations from US2/US3)
- **US5 (P2)**: after US1 + US2 (reads conversations); independent of US3/US4
- **US6 (P2)**: after US2 (conversation context for commerce panel)
- **US7 (P3)**: after US1 (admin config); CSAT after US2 (widget), automation after US4 (ticket events)

### Within Each User Story

- Tests written first and FAIL before implementation
- shared-types/contracts → services → portals/widget
- Models/contracts before services before UI
- i18n/RTL task last in each story

### Parallel Opportunities

- All `[P]` Setup tasks (T002–T006, T008–T009) run together
- Foundational: shared-types tasks (T015–T019) and service skeletons (T020–T024) run in parallel after schema (T010–T014)
- After Foundational, with enough staff: US4, US5, US6 can proceed in parallel (distinct service/feature dirs)
- Within a story, `[P]` tasks touch different files — run together

---

## Parallel Example: User Story 2

```bash
# Tests together:
Task: T039 socket events contract test
Task: T040 customer JWT verification test
Task: T041 contact upsert dedup test

# Independent implementation files together:
Task: T050 scaffold chat-widget (Preact)
Task: T054 agent-portal inbox list
```

---

## Implementation Strategy

### MVP First (P1 stories)

1. Phase 1 Setup → Phase 2 Foundational (CRITICAL gate)
2. US1 (sign-in + user/team mgmt) → validate → demo
3. US2 (realtime widget chat) → validate cross-instance → demo
4. US3 (shared inbox management) → validate → **P1 MVP: staffed realtime support inbox**

### Incremental Delivery (P2 → P3)

5. US4 tickets+SLA+notifications → demo (Phase 3)
6. US5 AI assistance → demo (Phase 4)
7. US6 profiles+commerce+branding → demo (Phase 5)
8. US7 automation+reporting+CSAT+custom fields+CSV → demo (Phase 6)
9. Phase 10 polish/hardening → run quickstart + acceptance criteria

### Parallel Team Strategy

After Foundational: one dev pair on US1→US2→US3 (sequential P1), then split US4/US5/US6 across devs, converge on US7 and polish.

---

## Notes

- `[P]` = different files, no incomplete dependencies
- `[Story]` label maps each task to its user story for traceability
- Each user story is an independently testable/deployable increment (matches spec Phases 1–6)
- Tests must fail before implementation (spec mandates Vitest + Playwright in CI)
- Commit the Directus schema snapshot on every schema change
- Service-account tokens and all secrets only via env — never committed
- Stop at any checkpoint to validate a story independently
