# Sara CRM — Omnichannel Customer Care Platform

A production customer-service platform for a multi-brand restaurant group in Saudi
Arabia, integrated with the Yiji food-ordering app. Built and operated end to end:
product, full-stack development, database, containerisation, AWS infrastructure,
domains, TLS, CI/CD and on-call operations.

**Status:** live in production, serving real customers. 940 commits, 23 tagged
releases, ~123,000 lines of TypeScript across 542 source files, 203 test files.

---

## What it does

Customers open a chat from inside the Yiji mobile app (or by scanning a QR code in
a restaurant). Agents answer from a web portal. Supervisors and administrators
manage tickets, SLAs, compensation coupons, reporting and staff permissions from a
second portal.

Core capabilities:

- **Real-time chat** between customers and agents — typing indicators, read
  receipts, attachments, message delivery states with retry, and conversation
  history that survives reconnects.
- **Automatic conversation routing** — a three-rung escalation ladder assigns a
  chat to the most idle agent, escalates to a second agent after 60 seconds of no
  reply, then releases it to every signed-in agent after a further 30 seconds.
  Chats are reclaimed if an agent signs out mid-conversation and does not return.
- **Ticketing and SLA engine** — policies scoped by type, channel and brand with
  most-specific-wins resolution, working-hours awareness, and first-response /
  resolution targets measured against the right object.
- **Compensation coupons** — an approval workflow that pushes approved coupons to
  the Yiji platform API and reconciles delivery.
- **CSAT** — post-resolution customer ratings feeding agent performance reporting.
- **AI assistant ("Aura")** — an in-portal assistant over Google Gemini that
  answers questions about the data and proposes automations as confirm-to-create
  actions, with PII redaction on the way out and rehydration on the way back.
- **Reporting** — agent performance, SLA compliance, ticket breakdowns, operations
  dashboards, CSV/Excel export and scheduled email reports.
- **Arabic/English** throughout, including right-to-left layout.

---

## Architecture

A pnpm monorepo of three front-end applications, three back-end services, a
headless CMS/API layer, and five shared packages.

```
apps/
  agent-portal      React 18 + Vite — the agent workspace
  admin-portal      React 18 + Vite — supervisor/administrator console
  chat-widget       Preact — embeddable customer chat (built as a library)
services/
  socket-gateway    Fastify + Socket.IO — real-time chat, auth, presence
  ai-gateway        Fastify — LLM orchestration, prompt handling, PII redaction
  workers           BullMQ — routing ladder, SLA sweeps, notifications, imports
directus/           Directus 11 headless CMS over PostgreSQL — data + REST API
packages/           ui, reports, i18n, shared-types, shared-config
```

### Technology

| Layer          | Technology                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| Language       | TypeScript 5.7 (strict), Node.js 20                                                                     |
| Front end      | React 18, Preact 10, Vite 6, Tailwind CSS 3, TanStack Query 5, React Router 7, React Hook Form, i18next |
| Back end       | Fastify 5, Socket.IO 4, BullMQ 5, ioredis 5, Pino, Zod, JSON Web Tokens                                 |
| Data           | PostgreSQL 15, Directus 11 (headless CMS), Redis 7                                                      |
| AI             | Google Gemini (`@google/generative-ai`)                                                                 |
| Testing        | Vitest 3 (unit + integration), Playwright (end-to-end), jsdom                                           |
| Tooling        | pnpm 9 workspaces, ESLint, Prettier, Husky + lint-staged                                                |
| Infrastructure | Docker, AWS ECS Fargate, ALB, ECR, S3, CloudFront, ACM, RDS, ElastiCache                                |
| CI/CD          | GitHub Actions with OIDC (no long-lived AWS keys)                                                       |

---

## Database

- **PostgreSQL 15** on AWS RDS, one instance hosting separate `crm_prod` and
  `crm_staging` databases.
- **61 collections**, 32 of them custom domain tables — conversations, messages,
  contacts, tickets, SLA policies, coupon approvals, CSAT responses, routing
  events, automation rules, custom fields, notifications, brands, app roles.
- Schema, permissions and roles are **provisioned as code** through a bootstrap
  service, so an environment can be rebuilt reproducibly rather than clicked
  together.
- Full audit trail via Directus revisions — field-level history and "last modified
  by" are derived from it.
- Work included migrations, a duplicate-merging phone-number normalisation across
  the whole contact base, index tuning found by measuring real query plans, and a
  retention strategy for an audit trail that had grown to 95% of total storage.

---

## Infrastructure and hosting (AWS, `us-east-2`)

Two complete environments — **production** and **staging** — deployed as mirrors.

- **Compute:** AWS ECS Fargate. Two clusters (`crm-prod`, `crm-staging`), four
  long-running services each: `directus`, `socket-gateway`, `ai-gateway`,
  `workers`.
- **Networking:** an Application Load Balancer with host- and path-based listener
  rules splitting traffic across both environments; tasks in private subnets
  egressing through an existing NAT gateway.
- **Containers:** seven Dockerfiles, images built and pushed to Amazon ECR,
  promoted between environments **by tag and verified by digest** so the artefact
  tested in staging is the exact artefact that reaches production.
- **Static hosting:** the two portals and the chat widget are built to S3 and
  served through six CloudFront distributions, invalidated automatically on
  deploy.
- **Data services:** Amazon RDS for PostgreSQL and ElastiCache for Redis
  (cluster-mode aware clients, with the CROSSSLOT and hash-tag constraints that
  imposes on BullMQ keyspaces).
- **Local development:** Docker Compose mirroring the production topology —
  Postgres 15, Redis 7, Directus 11.

### Domains and TLS

Eight public hostnames on `anan.sa`, each mapped to a CloudFront distribution with
an ACM certificate (issued in `us-east-1`, as CloudFront requires, independently of
the `us-east-2` compute region):

| Hostname                    | Serves                               |
| --------------------------- | ------------------------------------ |
| `crm.anan.sa`               | customer chat widget (production)    |
| `crm-agent.anan.sa`         | agent portal (production)            |
| `crm-admin.anan.sa`         | admin portal (production)            |
| `crm-api.anan.sa`           | API + WebSocket gateway (production) |
| `crm-staging.anan.sa`       | customer chat widget (staging)       |
| `crm-agent-staging.anan.sa` | agent portal (staging)               |
| `crm-admin-staging.anan.sa` | admin portal (staging)               |
| `crm-api-staging.anan.sa`   | API + WebSocket gateway (staging)    |

This involved specifying the exact DNS validation records for a third-party DNS
administrator, diagnosing certificate-before-DNS ordering failures, and handling
`sni-only` versus dedicated-IP cost trade-offs.

---

## CI/CD

Two GitHub Actions pipelines, authenticating to AWS by **OIDC role assumption**
rather than stored credentials.

**Quality gate (every push):** lint, format check, TypeScript typecheck, a custom
security call-site guard, unit tests with coverage for services and packages, app
tests under jsdom, dependency advisory scanning, i18n coverage checks, and a
Playwright end-to-end suite that boots Directus, bootstraps the schema, seeds a
vendor and runs real browser flows.

**Deploy pipeline:** builds and pushes all images, publishes portals and widget to
S3/CloudFront, requires a **single human approval** for production via a protected
GitHub Environment, rolls services one at a time waiting for ECS steady state, then
smoke-tests the public endpoints.

Reliability work on the pipeline itself included:

- Refusing to register a task definition whose image is not present in ECR —
  previously ECS would accept it and sit `IN_PROGRESS` forever with no error.
- Deriving task definitions from what is actually running rather than from repo
  templates carrying unsubstituted placeholders.
- Making the smoke test prove a host genuinely serves over HTTPS instead of
  trusting DNS resolution.
- Moving the production approval gate off the deploy matrix, so a release is
  approved once rather than once per service — and so the smoke test can no longer
  be silently skipped, which had let a release reach production unverified.

---

## Engineering practice

- **Verified on live systems, not assumed.** Fixes are proven against the running
  staging and production stacks with scripted probes — creating a real chat,
  driving a real logout, reading the resulting database rows — before being called
  done.
- **Regression tests that actually fail.** Each bug fix ships with a test confirmed
  to fail against the pre-fix code, so it guards the behaviour rather than
  describing it.
- **Root cause over symptom.** Several long-standing "mystery" defects turned out
  to be one cause with two faces; the fix addresses the cause and the reasoning is
  recorded in the commit for whoever reads it next.

### Representative problems solved

- **Auto-assignment had never worked in either environment** — a missing Directus
  permission on `directus_roles` combined with a role name that no longer existed.
  Found by measuring the roster against the live database rather than reading code.
- **Customers were told agents were online when nobody was there.** The shared
  presence registry was never swept, so agents from tasks killed during a rolling
  deploy stayed "online" indefinitely. Fixed by heartbeating connected agents,
  which redefines the stored score as "still connected" rather than "last typed"
  and makes sweeping safe.
- **Attachments failed silently** — four separate causes, chiefly an undocumented
  1 MB Socket.IO buffer default and an unhandled HEIC MIME type from iPhones.
- **WebSocket upgrades always failed through CloudFront** (HTTP/2 has no `Upgrade`
  header), so a harmless transport error was being treated as a dead connection and
  locked the chat composer.
- **A whole admin page rendered empty** because Directus rejects an entire query
  when any single requested field is inaccessible — a failure shape that looks like
  "no data" rather than an error.
- **20,397 duplicate SLA warnings across six tickets** — a BullMQ `removeOnComplete`
  setting was deleting the very job ID that provided idempotency.

---

## Role

Sole engineer across the full stack: requirements, architecture, database design,
front-end and back-end implementation, containerisation, AWS infrastructure,
domain and TLS setup, CI/CD, production deployment, monitoring and incident
response.
