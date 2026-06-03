# Phase 0 Research: Yiji CRM

The technology stack is fixed by the specification (non-negotiable). Research here resolves the **open choices the spec left to the builder** and records best-practice decisions for the mandated components. No `NEEDS CLARIFICATION` markers remained from the spec; the items below are the only genuine decision points.

---

## D-01: Chat widget framework — Preact vs vanilla TS

- **Decision**: **Preact + Vite**, with `preact/compat` avoided to keep size down.
- **Rationale**: Spec targets < 50 KB gzipped and "Preact or vanilla". Preact (~4 KB) gives component ergonomics, i18next, and RTL handling without a large runtime; vanilla TS would re-implement rendering/state by hand and slow delivery. Vite supports a library/IIFE build emitting a single embeddable script.
- **Alternatives considered**: Vanilla TS (smallest but high maintenance), React (too large for 50 KB), Lit (web-component overhead, weaker i18next story).

## D-02: Customer JWT verification scheme

- **Decision**: **HS256 with a shared secret in env** for the initial release; verification layer abstracts the algorithm so **RS256 with a public key** is a config swap later. Verify signature, `exp`, vendor existence (active), and identity-field sanity. Never trust query params.
- **Rationale**: Spec Section 9 explicitly allows HS256-for-MVP → RS256-later. Abstracting the verifier (key resolver + algorithm) makes the migration a one-file change.
- **Alternatives considered**: RS256 from day one (needs key distribution from Yiji platform, not yet available); opaque token introspection (requires a Yiji endpoint that isn't specified).

## D-03: Message persistence path for realtime

- **Decision**: socket-gateway is the **only** writer of customer/agent chat messages, persisting via the **Directus REST API** using its service-account token, then broadcasting via Socket.IO rooms. Side effects (SLA, notifications, automation) are emitted as **BullMQ jobs**, not done inline.
- **Rationale**: Keeps the gateway stateless and horizontally scalable (Redis adapter for cross-instance fanout); Directus stays the system of record; heavy work is offloaded to workers per spec Section 8.
- **Alternatives considered**: Portals writing messages directly to Directus (loses single realtime ordering point, complicates broadcast); gateway writing to Postgres directly (bypasses Directus permissions/hooks — rejected).

## D-04: SLA timer mechanism

- **Decision**: BullMQ **delayed jobs** scheduled at ticket creation — one job at the warning threshold time, one at each deadline — plus a periodic **reconciliation sweep** (repeatable job) to catch drift, restarts, and reopened tickets. Business-hours math computes the absolute fire times; reopen reschedules.
- **Rationale**: Delayed jobs are precise and cheap; the sweep guarantees correctness across worker restarts and clock changes. Computing absolute times up front respects per-policy business hours.
- **Alternatives considered**: Pure cron polling every minute (imprecise, scans all open tickets constantly); DB-trigger based (logic leaks into Postgres, hard to test).

## D-05: PII redaction approach (AI gateway)

- **Decision**: Deterministic **regex/pattern redaction** for the required categories — emails, phone numbers (incl. international), physical-address heuristics, card-like numbers (Luhn-aware), IBAN-like patterns — replacing with stable typed placeholders (e.g. `[EMAIL_1]`) before any Gemini call; mapping kept in-memory per request only.
- **Rationale**: Spec mandates these exact categories pre-call. Deterministic patterns are auditable and testable (success criterion SC-005 requires verifying outbound payloads). Luhn check reduces false positives on order IDs.
- **Alternatives considered**: ML-based PII detection (heavier, non-deterministic, harder to verify); no placeholder mapping (loses ability to restore entities in responses where safe).

## D-06: AI rate limiting + caching

- **Decision**: **Redis-backed** sliding-window rate limiting, two tiers (per-user and global), per endpoint; **response cache keyed by hash of the redacted prompt + endpoint + model**, TTL per endpoint. Admin-set monthly usage caps tracked as Redis counters with monthly reset, surfaced/configured via a Directus settings collection read by the gateway.
- **Rationale**: Matches spec FR-021 (per-user + global limits, caching keyed by content hash, admin usage caps). Redis already present; keeps gateway stateless.
- **Alternatives considered**: In-memory limiting (breaks under horizontal scaling); DB-counter rate limiting (too slow per request).

## D-07: Notification preferences storage

- **Decision**: Per-user preference map (notification type → channels in-app/email/both/none) stored on the user/settings; workers' `notifications` queue reads it and fans out only to enabled channels. In-app = write `notifications` row + socket push to the user's personal room; email = `MailTransport`.
- **Rationale**: Spec FR-018 / 11.9 require per-type channel control and dual delivery. Reusing the user's personal Socket.IO room gives instant in-app push.
- **Alternatives considered**: Global on/off only (insufficient granularity); separate preferences service (overkill).

## D-08: Automation engine evaluation + loop prevention

- **Decision**: `automation` worker loads **active** rules matching the trigger event, evaluates conditions, sorts by rule `priority`, executes actions, and writes a `ticket_events` row (`automation_triggered`) per execution. Loop prevention via a **per-event execution depth/visited-rule guard** carried on the job payload and a max-depth cap.
- **Rationale**: Spec FR-027 requires ordered execution + recorded events + loop prevention. A depth guard on the job is simple and robust against rule chains that re-trigger events.
- **Alternatives considered**: No loop guard (risk of infinite re-trigger — rejected); synchronous in-gateway evaluation (blocks realtime path).

## D-09: Reporting computation

- **Decision**: Reports computed by the `reports` worker via **Directus aggregation queries** over conversations/tickets/csat_responses with the report's filters; CSV export generated server-side; scheduled reports use BullMQ **repeatable jobs** from each report's cron `schedule`, delivering via `MailTransport`.
- **Rationale**: Keeps Directus the data source; avoids a separate analytics store for the required metric set. Repeatable jobs match `reports.schedule`.
- **Alternatives considered**: Dedicated OLAP/warehouse (out of scope for the listed metrics); client-side aggregation (won't scale, can't schedule).

## D-10: Directus schema reproducibility & bootstrap

- **Decision**: Define all 17 collections + roles + service accounts, then export a **committed schema snapshot** (`directus/snapshot/`) applied via `directus schema apply` on bootstrap; a `directus/bootstrap/` script seeds roles, service-account tokens (from env), and the admin owner. Snapshot re-committed on every schema change.
- **Rationale**: Spec Section 5 / FR-036 require reproducible, version-controlled schema and a one-command bootstrap.
- **Alternatives considered**: Manual UI configuration (not reproducible); raw SQL migrations (bypasses Directus metadata — rejected).

## D-11: Yiji platform integration boundary

- **Decision**: `YijiClient` **interface in `packages/shared-types`** with `getCustomer`, `getOrders`, `getPaymentStatus`, `getShipmentTracking`, `getPurchaseActivity`; a configurable **mock implementation** for dev and a real HTTP implementation selected by env (`YIJI_API_URL` present → real, else mock). Agent Portal consumes it via the agent-portal backend-for-frontend path or directly where read-only.
- **Rationale**: Spec FR-024 / 11.11 mandate the interface + mock + env-selectable real impl.
- **Alternatives considered**: Hard-coding Yiji calls in the portal (couples UI to external API — rejected).

## D-12: Append-only enforcement for ticket_events

- **Decision**: Enforce no-update / no-delete on `ticket_events` via **Directus role permissions** (create + read only) for every role including service accounts; writes happen through the `workers` service account which also lacks update/delete on that collection.
- **Rationale**: Spec Section 6/7/14 and FR-014 require append-only enforced by role permissions, not just convention.
- **Alternatives considered**: DB triggers blocking UPDATE/DELETE (defense-in-depth, can be added later; permissions are the spec's stated mechanism).

---

## Cross-cutting best practices adopted

- **Stateless services**: no in-process session/state in socket-gateway or workers; all shared state in Redis/Directus. Enables horizontal scale (SC-010).
- **Graceful shutdown**: SIGTERM handlers drain Socket.IO connections and let BullMQ finish in-flight jobs; dead-letter queue for exhausted retries.
- **Observability**: pino structured logging + `/health` (liveness) and `/ready` (readiness: Redis + Directus reachable) on every Node service.
- **i18n**: i18next per app with shared keys; RTL via `dir="rtl"` + Tailwind logical properties; locale resolved from user profile (default browser).
- **Security**: per-IP + per-user rate limits on custom services; attachment MIME allowlist + size cap; webhook signature verification; secrets only via env; HTTPS + per-env CORS in prod.
- **Testing**: contract tests for socket events, AI endpoints, and YijiClient mock; integration tests for SLA/automation flows; Playwright E2E for the cross-instance realtime acceptance (SC-010).
