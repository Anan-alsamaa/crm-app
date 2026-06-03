# Feature Specification: Yiji CRM — Centralized Internal Support & CRM Platform

**Feature Branch**: `001-yiji-crm-platform`

**Created**: 2026-05-20

**Status**: Draft

**Input**: User description: "Yiji CRM — Complete Project Specification (centralized, internal customer support and CRM platform for the Yiji ecosystem, operated by Yiji's internal support team; vendors are data entities; customers interact only through an embedded chat widget authenticated by Yiji-signed JWTs)."

## Overview

Yiji CRM is an internal customer-support and relationship-management platform operated exclusively by Yiji's own support team. Support agents work conversations and tickets through an Agent Portal; administrators configure the system through an Admin Portal. End customers never log in — they reach support only through an embeddable chat widget, identified by a signed token issued by the host Yiji platform. Vendors are records in the system (with branding and external references), not users.

The platform centralizes realtime chat, a shared inbox, ticketing with SLA enforcement, automation, AI assistance, customer profiles enriched with commerce data, notifications, reporting, and bilingual (English/Arabic, RTL-aware) interfaces. Delivery is phased; each phase is independently reviewable and deployable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Support staff sign in and operate within their role (Priority: P1)

Support agents and administrators sign in to their respective portals with credentials managed centrally. Agents see only what their role permits (conversations, tickets, contacts they handle); administrators can configure the system; the project owner has full superuser access. Administrators can create and manage agent accounts and organize them into teams.

**Why this priority**: Nothing else in the platform is usable or safe without authenticated, role-scoped access. This is the foundation every other story depends on, and it constitutes a deployable slice (a working login + user/team management) on its own.

**Independent Test**: Create an agent and an admin account, sign each into the correct portal, confirm the agent cannot reach admin-only configuration, confirm the admin can create a user and assign them to a team, and confirm sessions persist and refresh without forcing re-login.

**Acceptance Scenarios**:

1. **Given** a valid agent account, **When** the agent signs into the Agent Portal, **Then** they reach the inbox and see only conversations/tickets permitted by their role.
2. **Given** a valid admin account, **When** the admin signs into the Admin Portal, **Then** they can manage users, teams, and system configuration.
3. **Given** an agent session, **When** the agent attempts to access an admin-only configuration area, **Then** access is denied.
4. **Given** an expired access session with a valid refresh credential, **When** the portal refreshes, **Then** the user continues working without re-entering credentials.
5. **Given** an admin on the user-management screen, **When** they create a new agent and assign a team, **Then** the agent appears in that team and can subsequently sign in.

---

### User Story 2 - Customer chats via widget and agent replies in realtime (Priority: P1)

A customer on a Yiji vendor's site opens the embedded chat widget, which authenticates them with a Yiji-issued signed token (no login). A conversation is created (or an existing open one resumed) and the matching customer contact record is created or matched. The customer's messages appear in the agent's shared inbox in realtime; the agent's replies appear in the widget in realtime. Both sides see typing indicators and unread counts, and the widget reconnects automatically after network drops.

**Why this priority**: Realtime two-way support chat is the core purpose of the platform. Combined with Story 1 it delivers the central promised capability: a customer gets help from a live agent.

**Independent Test**: Load the widget on a test page with a valid signed token, send a message as the customer, confirm it appears in an agent's inbox in realtime, reply as the agent, and confirm the reply appears in the widget within the realtime latency target; drop and restore the connection and confirm messages are not lost.

**Acceptance Scenarios**:

1. **Given** a valid signed customer token, **When** the widget initializes, **Then** the customer is authenticated, their contact is matched or created (deduplicated per vendor), and an open conversation is presented or created.
2. **Given** an invalid, tampered, or expired token, **When** the widget attempts to connect, **Then** the connection is refused and no conversation is created.
3. **Given** a connected customer, **When** the customer sends a message, **Then** it appears in the relevant agent inbox view in realtime and increments the agent unread count.
4. **Given** an agent viewing the conversation, **When** the agent replies, **Then** the customer sees the reply in the widget in realtime.
5. **Given** an active conversation, **When** either party is typing, **Then** the other party sees a typing indicator.
6. **Given** a dropped network connection on the widget, **When** connectivity returns, **Then** the widget reconnects automatically and conversation continuity is preserved.
7. **Given** the resolved vendor for the conversation, **When** the widget renders, **Then** it reflects that vendor's logo and colors.

---

### User Story 3 - Agent manages the shared inbox and conversations (Priority: P1)

Agents work a shared inbox listing conversations they can act on. They assign conversations to themselves, another agent, or a team; change status (open/pending/resolved/closed) and priority; add tags; write internal notes (not visible to the customer) with @mentions of colleagues; search and filter conversations; sort columns; and act on multiple conversations at once. Opening a conversation shows full message history, the linked contact profile, and any linked tickets.

**Why this priority**: A shared inbox with assignment, status, and notes is what turns realtime chat into managed support work. It is required for any real support team to operate.

**Independent Test**: With several seeded conversations, assign one to an agent, change its status and priority, add a tag and an internal note with an @mention, filter and search to locate it, and perform a bulk status change on multiple conversations — confirming each change persists and is reflected for other agents.

**Acceptance Scenarios**:

1. **Given** the inbox, **When** an agent assigns a conversation to a team or agent, **Then** the assignment persists and is visible to other agents in realtime.
2. **Given** an open conversation, **When** the agent changes status or priority or adds tags, **Then** the changes persist and are reflected in inbox listing and filters.
3. **Given** a conversation, **When** an agent adds an internal note with an @mention, **Then** the note is stored as internal (never delivered to the customer) and the mentioned user is notified.
4. **Given** many conversations, **When** the agent applies search and multi-criteria filters and sorts columns, **Then** the listing reflects the criteria.
5. **Given** multiple selected conversations, **When** the agent performs a bulk action, **Then** the action applies to all selected conversations.

---

### User Story 4 - Tickets with SLA enforcement and notifications (Priority: P2)

Agents create tickets from a conversation or standalone, and move them through the workflow (new → open → pending → resolved → closed). When a ticket is created with a priority that maps to an SLA policy, first-response and resolution deadlines are computed (respecting configured business hours). Background monitoring raises a warning when a deadline approaches its configured threshold and marks a breach when a deadline passes. Every meaningful change is recorded as an append-only ticket event, and the relevant staff receive in-app and email notifications for assignments, mentions, status changes, SLA warnings, breaches, and escalations. Each user controls which notification channels they receive per notification type.

**Why this priority**: Ticketing plus SLA accountability is the difference between ad-hoc chat and a managed support operation, but it builds on the inbox (P1) and is meaningful only once conversations exist.

**Independent Test**: Configure an SLA policy, create a ticket at a matching priority, confirm response/resolution deadlines are computed; advance time (or use short thresholds) to confirm a warning event and notification fire at the threshold and a breach event and notification fire after the deadline; confirm each change appears in the ticket's append-only history and cannot be edited or deleted.

**Acceptance Scenarios**:

1. **Given** an SLA policy applicable to a priority, **When** a ticket is created at that priority, **Then** first-response and resolution deadlines are computed (respecting business hours when configured).
2. **Given** a ticket with deadlines, **When** the warning threshold is crossed, **Then** a warning event is recorded and a notification is sent to the responsible staff.
3. **Given** a ticket with deadlines, **When** a deadline passes without satisfaction, **Then** a breach event is recorded, a notification is sent, and escalation handling triggers.
4. **Given** any ticket change (status, assignment, comment, SLA event), **When** it occurs, **Then** an append-only ticket event is recorded and cannot be modified or deleted.
5. **Given** a user's notification preferences, **When** a notification is generated, **Then** it is delivered only on the channels the user enabled for that type, in-app and/or email.
6. **Given** an agent is assigned a ticket or @mentioned, **When** the event occurs, **Then** they receive a notification with a deep link to the relevant item.

---

### User Story 5 - AI assistance for agents (Priority: P2)

From the Agent Portal, agents invoke AI helpers on a conversation: summarize it, suggest a reply (optionally refining a draft), analyze sentiment, detect intent, extract entities (names, products, order references, etc.), search past conversations by meaning, and score a lead. Before any text leaves the platform for the AI provider, personal and sensitive data (emails, phone numbers, physical addresses, payment/card-like and IBAN-like references) is redacted. Administrators choose which AI features are enabled and set usage caps; rate limits protect the provider budget.

**Why this priority**: AI assistance is a major value-add that improves agent speed and quality, but it is an enhancement layered on working conversations rather than a prerequisite for support.

**Independent Test**: With a seeded conversation containing PII, invoke each AI feature and confirm a provider-generated result returns; inspect the payload sent externally and confirm all PII categories are redacted; disable a feature in admin config and confirm it is unavailable; exceed a rate limit and confirm requests are throttled.

**Acceptance Scenarios**:

1. **Given** a conversation, **When** an agent requests any AI feature, **Then** a provider-generated result is returned through the AI gateway.
2. **Given** content containing emails, phone numbers, addresses, or payment references, **When** an AI request is made, **Then** all such data is redacted before any external call.
3. **Given** an admin disables a specific AI feature or sets a usage cap, **When** an agent attempts to use it beyond the configured limits, **Then** the feature is unavailable or the request is refused.
4. **Given** repeated identical requests, **When** rate or usage limits are reached, **Then** further requests are throttled or served from cache where applicable.

---

### User Story 6 - Customer profiles enriched with commerce data and branding (Priority: P2)

Agents open a customer's contact profile to see a timeline (conversations, tickets, key events), full conversation history, tags, and — alongside the conversation — a side panel of the customer's commerce data (orders, payment status, shipment tracking, purchase activity) sourced from the Yiji platform. Contacts are deduplicated per vendor by phone and email, and contact lists can be exported. Per-vendor branding (logo, colors, theme) is configurable and is what the widget inherits.

**Why this priority**: Context (who the customer is and what they bought) materially improves support quality and is required for the order-history experience promised to agents, but support functions without it.

**Independent Test**: Open a contact profile and confirm the timeline, history, and tags render; confirm the commerce side panel shows order/payment/shipment data from the (mockable) Yiji source; create a duplicate-looking contact for the same vendor and confirm deduplication; export contacts and confirm the file contents; edit a vendor's branding and confirm the widget reflects it.

**Acceptance Scenarios**:

1. **Given** a contact, **When** an agent opens the profile, **Then** they see a timeline, full conversation history, and tags.
2. **Given** a conversation tied to a known customer, **When** the agent views it, **Then** a side panel shows that customer's orders, payment status, shipment tracking, and purchase activity from the Yiji source.
3. **Given** two inbound identities for the same vendor sharing a phone or email, **When** contacts are upserted, **Then** they resolve to a single deduplicated contact.
4. **Given** a set of contacts, **When** an agent exports them, **Then** a downloadable file containing the contact data is produced.
5. **Given** a vendor's branding configuration, **When** it is updated, **Then** the widget for that vendor reflects the new logo and colors.

---

### User Story 7 - Automation, reporting, CSAT, and custom fields (Priority: P3)

Administrators define automation rules (trigger + conditions + actions) that run on matching events to auto-assign, auto-tag, set priority/status, escalate, or notify, in a defined execution order, each execution recorded as a ticket event. Administrators view reporting dashboards (conversation volume, response time, SLA compliance, ticket resolution, agent productivity, CSAT, vendor activity) with vendor/agent/team/date filters and CSV export, and can schedule reports for automated email delivery. On conversation close (or manual trigger) the customer is offered a CSAT survey (1–5 plus optional comment) in the widget, and results aggregate into reports. Administrators define custom fields per entity (contact, conversation, ticket) that the Agent Portal renders dynamically and that are searchable/filterable. Contacts can be imported via CSV.

**Why this priority**: These are operational maturity features (optimization, measurement, configurability). They depend on the core entities and workflows already existing, so they come last while still being in scope.

**Independent Test**: Create an automation rule and trigger its event, confirming the action executes and a ticket event is recorded; open a reporting dashboard, filter it, export CSV, and schedule a report that then delivers by email; close a conversation and confirm the CSAT prompt appears and the response is stored and counted in reports; define a custom field and confirm it renders and is filterable; import a contacts CSV and confirm the contacts appear deduplicated.

**Acceptance Scenarios**:

1. **Given** an active automation rule, **When** its trigger event occurs and conditions match, **Then** its actions execute in priority order and an automation event is recorded.
2. **Given** reporting data, **When** an admin applies filters, **Then** the dashboards reflect the filters and can be exported to CSV.
3. **Given** a report with a schedule, **When** the schedule fires, **Then** the report is generated and emailed to its recipients.
4. **Given** a conversation is closed (or CSAT is triggered), **When** the customer responds in the widget, **Then** the 1–5 score and optional comment are stored once per conversation and aggregated in reports.
5. **Given** a custom field defined for an entity, **When** an agent views that entity, **Then** the field renders dynamically and is searchable/filterable.
6. **Given** a contacts CSV, **When** an admin imports it, **Then** contacts are created and deduplicated per vendor.

---

### Edge Cases

- **Invalid/expired/tampered customer token**: connection refused; no contact or conversation created; no information leaked about why beyond a generic failure.
- **Token references a non-existent or inactive vendor**: connection refused.
- **Concurrent contact creation** for the same vendor+phone/email (race): resolves to a single contact without duplicate records.
- **Conversation has both an email and phone that match different existing contacts**: deterministic, documented resolution to avoid silent data merges.
- **Network drop mid-conversation** (widget or agent): automatic reconnect with exponential backoff; no duplicate or lost messages.
- **SLA business hours configured**: deadlines computed only across business hours; **24/7 (no business hours)**: deadlines computed continuously.
- **Ticket reopened after resolution/closure**: recorded as an event; SLA handling behavior on reopen is defined.
- **Multiple automation rules match the same event**: execute in defined priority order; conflicting actions resolved deterministically.
- **Automation rule would create an infinite loop** (an action re-triggers the same rule): loop prevention.
- **AI provider unavailable, slow, or over quota**: agent receives a clear failure/degraded state, not a hang; usage cap reached blocks further calls gracefully.
- **PII pattern partially matches** (e.g., numbers that look card-like but are order IDs): redaction errs toward protecting data; documented behavior.
- **Customer attaches a disallowed file type or oversize file**: rejected with a clear message; allowlist and size limits enforced.
- **Append-only history**: any attempt to edit or delete a ticket event is rejected.
- **Notification preference disables all channels for a type**: no notification sent for that type; system does not error.
- **CSAT submitted twice for one conversation**: only one response retained per conversation.
- **Horizontal scaling**: with multiple realtime gateway instances, a message from a customer connected to one instance reaches an agent connected to another.
- **RTL/Arabic content**: layouts, ordering, and input render correctly in Arabic; mixed LTR/RTL content displays sensibly.

## Requirements *(mandatory)*

### Functional Requirements

**Authentication, Roles & Permissions**

- **FR-001**: System MUST authenticate support agents and administrators with centrally managed credentials and provide password reset, session management, and session refresh without forcing re-login on expiry.
- **FR-002**: System MUST enforce role-scoped access for four role types — Administrator/superuser (full), Admin (business configuration and user/team management, no schema changes, cannot remove the superuser role), Agent (work conversations/tickets/contacts within assignment scope; read-only on configuration), and service roles for internal services scoped to least privilege.
- **FR-003**: System MUST allow administrators to create and manage agent and admin accounts and to organize users into teams.
- **FR-004**: System MUST authenticate customers solely via a signed token issued by the host platform, verified server-side (signature, expiration, vendor existence, identity sanity); raw query parameters MUST NOT be trusted.

**Realtime Chat & Widget**

- **FR-005**: System MUST provide an embeddable chat widget that initializes from a host-provided signed token, supports realtime two-way messaging, typing indicators, unread counters, and automatic reconnect with exponential backoff.
- **FR-006**: On valid customer token, System MUST match or create the customer's contact (deduplicated per vendor by phone and by email where present), attach vendor context, and resume an open conversation or create a new one, with prior conversations available for context.
- **FR-007**: Widget MUST support file attachments validated by an allowed-type list and size limits, MUST support English and Arabic with RTL-aware layout, and MUST be mobile responsive.
- **FR-008**: Widget MUST automatically reflect the resolved vendor's branding (logo, colors, theme).
- **FR-009**: System MUST deliver realtime messaging across horizontally scaled realtime instances such that participants connected to different instances exchange messages correctly, with room-based routing per conversation, per agent, and per vendor, plus presence tracking.

**Shared Inbox & Conversation Management**

- **FR-010**: System MUST present agents a shared inbox of conversations they may act on, with assignment to agent or team, status (open/pending/resolved/closed), priority (low/medium/high/urgent), tagging, search, multi-criteria filtering, sortable columns, and bulk actions.
- **FR-011**: System MUST allow internal notes that are never delivered to customers, including @mentions that notify the mentioned user.
- **FR-012**: Opening a conversation MUST show full message history, the linked contact profile, and any linked tickets.

**Tickets, SLA & Notifications**

- **FR-013**: System MUST allow ticket creation from a conversation or standalone, with the workflow new → open → pending → resolved → closed, priorities, assignment to agent or team, internal notes, mentions, and attachments.
- **FR-014**: System MUST record an append-only history of ticket events (created, status changed, assigned, commented, SLA warning, SLA breached, resolved, closed, reopened, automation triggered) that cannot be edited or deleted.
- **FR-015**: System MUST let administrators configure SLA policies (applicable priorities, first-response and resolution durations, warning threshold percent, optional business hours, active flag).
- **FR-016**: On ticket creation, System MUST attach the applicable SLA policy by priority and compute first-response and resolution deadlines, respecting business hours when configured and treating absence of business hours as 24/7.
- **FR-017**: Background monitoring MUST raise a warning at the configured threshold and a breach when a deadline passes, recording the corresponding ticket events and dispatching notifications, and triggering escalation on breach.
- **FR-018**: System MUST deliver notifications in-app and via email for SLA warnings/breaches, assignments, mentions, ticket status changes, escalations, automation outcomes, and reminders, honoring each user's per-type channel preferences, with deep links into the Agent Portal.

**AI Assistance**

- **FR-019**: System MUST offer agents, routed through a dedicated AI gateway, the capabilities: summarize conversation, suggest reply (optionally given a draft), analyze sentiment, detect intent, extract entities, semantic search over past conversations, and score lead.
- **FR-020**: System MUST redact personal and sensitive data (email addresses, phone numbers, physical addresses, payment/card-like numbers, IBAN-like patterns) before any external AI call.
- **FR-021**: System MUST let administrators enable/disable individual AI features and set usage caps, and MUST enforce per-user and global rate limits with response caching where applicable.
- **FR-022**: System MUST isolate the AI provider behind a swappable interface so changing providers does not require changes across the application.

**Customer Profiles, Commerce Integration & Branding**

- **FR-023**: System MUST present a contact profile with a timeline (conversations, tickets, key events), full conversation history, and tags, and MUST support contact search, filtering, and CSV export.
- **FR-024**: System MUST display, alongside conversations, the customer's commerce data (customer record, orders, payment status, shipment tracking, purchase activity) sourced from the host platform via a defined client interface with a configurable mock for development and a real implementation selectable by configuration.
- **FR-025**: System MUST deduplicate contacts per vendor on phone and email where non-null.
- **FR-026**: System MUST let administrators manage per-vendor branding (logo, colors, support theme) used by the widget.

**Automation, Reporting, CSAT & Custom Fields**

- **FR-027**: System MUST let administrators define automation rules with a trigger event, conditions, and actions (assign agent/team, set priority/status, add tag, send notification, escalate), execute matching rules in a defined priority order on triggering events, and record each execution as an automation ticket event, with loop prevention.
- **FR-028**: System MUST provide administrator reporting dashboards (conversation volume, response time, SLA compliance, ticket resolution, agent productivity, CSAT, vendor activity) with vendor/agent/team/date filters and CSV export.
- **FR-029**: System MUST support scheduled reports that generate and deliver to recipients by email on a defined schedule.
- **FR-030**: System MUST offer the customer a CSAT survey (score 1–5 plus optional comment) on conversation close or manual trigger, store at most one response per conversation, and aggregate results into reports.
- **FR-031**: System MUST let administrators define custom fields per entity type (contact, conversation, ticket) that the Agent Portal renders dynamically and that are searchable and filterable.
- **FR-032**: System MUST support CSV import of contacts, applying per-vendor deduplication.

**Cross-cutting**

- **FR-033**: System MUST present all staff- and customer-facing interfaces in both English and Arabic with full RTL-aware layout in Arabic, with locale defaulting to the browser and overridable per user.
- **FR-034**: System MUST rate-limit custom service endpoints per-IP and per-authenticated-user, validate and sign-verify any inbound webhooks, validate attachments (type allowlist, size limit), keep secrets in environment configuration, and enforce HTTPS and environment-appropriate CORS in production.
- **FR-035**: System MUST process asynchronous work (SLA monitoring, notification dispatch, automation, AI jobs, CSV imports, scheduled reports) through background workers with retry and dead-letter handling and graceful shutdown.
- **FR-036**: System MUST be reproducible from a documented setup: the full backend stack starts from a single orchestration entry point after configuration is supplied, the data schema and roles are version-controlled and re-applicable, and documentation covers startup, sign-in, schema re-apply, and local reset.

### Key Entities *(include if feature involves data)*

- **Vendor**: A business in the Yiji ecosystem represented as data (not a user); holds name, branding (logo/colors), support settings, an external Yiji reference, and active status. Linked to contacts, conversations, and tickets.
- **User (staff)**: An agent or administrator with a role, locale, team membership, and status.
- **Team**: A named group of users for assignment and routing.
- **Contact (customer)**: A customer of a vendor, identified by external customer reference, name, phone, email, avatar, tags, custom field values, and an extensible metadata bag; deduplicated per vendor by phone/email.
- **Conversation**: A chat thread between a customer and support, belonging to a vendor and contact, with assigned agent/team, status, priority, tags, last-activity time, agent unread count, and an optional CSAT response.
- **Message**: An entry in a conversation from a customer, agent, or the system; may be an internal note, may carry attachments and @mentions, and tracks read state.
- **Ticket**: A tracked support item linked optionally to a conversation and required to a contact and vendor; has subject, description, status, priority, assignment, an optional SLA policy, computed/actual response and resolution timestamps, and tags.
- **Ticket Event**: An append-only audit record of a change to a ticket, with event type, optional actor (null when system-generated), and a payload of previous/new values.
- **Notification**: A message to a staff user of a given type, with title/body/deep-link, per-channel delivery timestamps, and read state.
- **SLA Policy**: A configuration of applicable priorities, first-response and resolution durations, warning threshold, optional business hours, and active flag.
- **Automation Rule**: A configuration of trigger event, conditions, ordered actions, active flag, execution-order priority, and trigger statistics.
- **Report**: A configuration of report type, filters, optional schedule with recipients, last-run time, and owner.
- **Tag**: A reusable label with name, color, and description.
- **Custom Field** / **Custom Field Value**: An administrator-defined field for an entity type and its stored values keyed to specific entity records.
- **CSAT Response**: A customer satisfaction result for a conversation (score 1–5, optional comment, submission time), at most one per conversation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After configuration is supplied, the full backend support stack starts from a single orchestration entry point with no further manual steps, and a project owner can sign in successfully.
- **SC-002**: A customer message sent from the widget is visible to an assigned agent, and an agent reply is visible in the widget, within 500 ms at the 95th percentile under expected load.
- **SC-003**: An agent can sign in, locate a conversation, and send a reply in under 1 minute on first attempt without assistance.
- **SC-004**: 100% of tickets created with an SLA-eligible priority receive computed first-response and resolution deadlines, and 100% of crossings of the warning threshold and of deadline breaches produce the corresponding recorded event and notification.
- **SC-005**: 100% of AI requests have all defined PII categories redacted before any external call (verified by inspecting outbound payloads), and disabling a feature or reaching a usage cap reliably prevents the corresponding external calls.
- **SC-006**: 0 ticket events can be edited or deleted after creation (append-only verified).
- **SC-007**: Contact deduplication yields 0 duplicate contacts for the same vendor sharing a phone or email across realtime upserts and CSV import.
- **SC-008**: 100% of scheduled reports due in a period are generated and delivered to their recipients.
- **SC-009**: Both English and Arabic render correctly across all three interfaces, with Arabic shown in correct RTL layout, verified on every primary screen.
- **SC-010**: With more than one realtime gateway instance running, 100% of messages route correctly between participants connected to different instances.
- **SC-011**: The Agent Portal initial load completes in under 2 seconds on a broadband connection.
- **SC-012**: An administrator can configure an SLA policy, an automation rule, a custom field, and a scheduled report, and view reporting dashboards, entirely through the Admin Portal without superuser/database access.
- **SC-013**: A CSAT prompt appears on conversation close and at most one response per conversation is stored and reflected in CSAT reporting.

## Assumptions

- The host Yiji platform is the source of truth for customer identity (issuing signed tokens) and for commerce data (customer/orders/payments/shipments/purchases); during development these are represented by a configurable mock, with a real integration selectable by configuration.
- Customer tokens are validated with a shared-secret signature scheme for the initial release, with room to move to a public-key scheme later, without changing the customer experience.
- Vendors never authenticate or access any interface; they exist only as data.
- The supplied local development credentials are weak by design and are for local use only; production requires strong credentials supplied via environment configuration, and documentation must call this out.
- File storage, email transport, the AI provider, and the host-platform client are each accessed through an interface so the concrete implementation is configurable per environment.
- "Business hours" for SLA are optional per policy; when omitted, SLA timing is continuous (24/7).
- Reasonable industry-standard defaults apply where unspecified: attachment type allowlist and size limits, data-retention practices, user-friendly error handling with fallbacks, and standard session/token lifetimes.
- Reporting metrics are derived from the platform's own conversation/ticket/CSAT data; external commerce metrics beyond what the host client exposes are out of scope.
- The platform is delivered in phases; each phase is independently reviewable and deployable, and earlier phases are prerequisites for later ones as reflected in the user-story priorities.
- No capabilities beyond those described are introduced without explicit confirmation.
