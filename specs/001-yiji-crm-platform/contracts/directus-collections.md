# Contract: Directus collections, roles & permission matrix

Directus auto-generates REST + GraphQL CRUD for every collection in [data-model.md](../data-model.md). This contract pins down the **role permission matrix** (spec Section 7), which is the security-critical part and must be reproduced in the committed snapshot.

## Roles
- **Administrator** (built-in) — project owner / superuser. Full access. Not deletable by Admin role.
- **Admin** — CRM administrators.
- **Agent** — support agents.
- **svc-socket-gateway**, **svc-workers**, **svc-ai-gateway** — service accounts (static tokens from env).

## Permission matrix

Legend: C=create R=read U=update D=delete · `R*`=scoped read · `—`=none

| Collection | Administrator | Admin | Agent | svc-socket-gateway | svc-workers | svc-ai-gateway |
|---|---|---|---|---|---|---|
| vendors | CRUD | CRUD | R | R | — | — |
| directus_users | CRUD | CRUD | R* (self+team) | R | R | — |
| teams | CRUD | CRUD | R | R | — | — |
| contacts | CRUD | CRUD | R* (handled vendors) | CRU | R | R |
| conversations | CRUD | CRUD | CRU* (assigned/unassigned) | CRU | CRU | R |
| messages | CRUD | CRUD | CRU* (in scope) | CRU | R | R |
| tickets | CRUD | CRUD | CRU* (assigned/team) | — | CRU | — |
| ticket_events | CR (no U/D) | CR | R | — | **CR (no U/D)** | — |
| notifications | CRUD | CRUD | R* (self) + U(read_at) | — | CRU | — |
| sla_policies | CRUD | CRUD | R | — | R | — |
| automation_rules | CRUD | CRUD | R | — | RU (counters) | — |
| reports | CRUD | CRUD | R* | — | RU | — |
| tags | CRUD | CRUD | R | — | R | — |
| custom_fields | CRUD | CRUD | R | — | R | — |
| custom_field_values | CRUD | CRUD | CRU* | — | R | — |
| csat_responses | CRUD | CRUD | R | CR | R | — |

### Hard rules
- **ticket_events is append-only for everyone** — no role (including Administrator via this matrix's intent and all service accounts) gets `U`/`D`. Enforced by Directus permissions (FR-014, D-12).
- **svc-ai-gateway is read-only** — reads conversations + messages, writes nothing (spec Section 7).
- Agent scoping is enforced with Directus permission **filters** (e.g. conversations where `assigned_agent = $CURRENT_USER` OR `assigned_agent IS NULL`; tickets where assigned to user or user's team; contacts of handled vendors).
- Admin **cannot modify schema** and **cannot delete the Administrator role** (Directus admin-access flag stays off for Admin role).

## Bootstrap / reproducibility
- All collections, fields, relations, roles, and the permission rows above are captured in `directus/snapshot/` and applied via `directus schema apply` (D-10, FR-036).
- Service-account tokens injected from env (`SVC_GATEWAY_TOKEN`, `SVC_WORKERS_TOKEN`, `SVC_AI_TOKEN`); never committed.
- Owner admin seeded from `DIRECTUS_ADMIN_EMAIL` / `DIRECTUS_ADMIN_PASSWORD` (weak dev values; prod must override — README must warn).
