# Phase 1 Data Model: Yiji CRM

All collections live in **Directus** (PostgreSQL). Every collection has Directus defaults — `id` (UUID), `date_created`, `date_updated`, `user_created`, `user_updated` — unless noted. This mirrors spec Section 6 exactly; relationships and validation rules below are the authoritative reference for `packages/shared-types` Zod schemas.

Legend: m2o = many-to-one, o2m = one-to-many, m2m = many-to-many, o2o = one-to-one.

---

## vendors
| Field | Type | Notes |
|---|---|---|
| name | string | required |
| logo | file (m2o directus_files) | nullable |
| colors | json | `{ primary, secondary, accent }` |
| support_settings | json | extensible |
| yiji_vendor_id | string | **unique**, external Yiji reference |
| status | enum | `active` \| `inactive` |

Relationships: o2m → contacts, conversations, tickets. **Rule**: widget branding resolved from this record.

## users (extends directus_users)
| Field | Type | Notes |
|---|---|---|
| team | m2o → teams | nullable |
| locale | enum | `en` \| `ar` |
| (role) | Directus role | see roles in plan/contracts |
| status | Directus default | active/suspended/etc. |
| notification_preferences | json | type → channel map (in_app/email/both/none) — see D-07 |

## teams
| Field | Type | Notes |
|---|---|---|
| name | string | required |
| description | text | |
| members | o2m → users | via `users.team` |

## contacts
| Field | Type | Notes |
|---|---|---|
| vendor | m2o → vendors | **required** |
| external_customer_id | string | Yiji customer ID |
| name | string | |
| phone | string | indexed |
| email | string | indexed |
| avatar | file | nullable |
| tags | m2m → tags | |
| metadata | json | extensible bag |
| custom_field_values | o2m → custom_field_values | |

**Validation / dedup**: `(vendor, phone)` unique where phone non-null; `(vendor, email)` unique where email non-null. Upsert (widget + CSV import) must resolve to a single contact (SC-007). Conflicting phone/email matches → deterministic resolution (prefer existing contact matched by phone, then email; documented in edge cases).

## conversations
| Field | Type | Notes |
|---|---|---|
| vendor | m2o → vendors | required |
| contact | m2o → contacts | required |
| assigned_agent | m2o → users | nullable |
| assigned_team | m2o → teams | nullable |
| status | enum | `open` \| `pending` \| `resolved` \| `closed`; default `open` |
| priority | enum | `low` \| `medium` \| `high` \| `urgent`; default `medium` |
| tags | m2m → tags | |
| last_message_at | datetime | indexed |
| unread_count_agent | integer | maintained by gateway |
| csat_response | o2o → csat_responses | nullable |

**State transitions**: open → pending → resolved → closed (and reopen → open). CSAT prompt fires on → closed (or manual). 

## messages
| Field | Type | Notes |
|---|---|---|
| conversation | m2o → conversations | required |
| sender_type | enum | `customer` \| `agent` \| `system` |
| sender_user | m2o → users | set when sender_type=agent |
| sender_contact | m2o → contacts | set when sender_type=customer |
| content | text | |
| attachments | m2m → directus_files | MIME allowlist + size cap |
| is_internal_note | boolean | default false — never delivered to customer |
| mentions | m2m → users | notifies mentioned users |
| read_by | json | `[{ userId, at }]` |

**Rule**: internal notes (`is_internal_note=true`) are excluded from any customer-facing payload.

## tickets
| Field | Type | Notes |
|---|---|---|
| conversation | m2o → conversations | nullable |
| contact | m2o → contacts | required |
| vendor | m2o → vendors | required |
| subject | string | required |
| description | text | |
| status | enum | `new` \| `open` \| `pending` \| `resolved` \| `closed`; default `new` |
| priority | enum | `low` \| `medium` \| `high` \| `urgent`; default `medium` |
| assigned_agent | m2o → users | nullable |
| assigned_team | m2o → teams | nullable |
| sla_policy | m2o → sla_policies | nullable |
| first_response_due_at | datetime | computed on create |
| resolution_due_at | datetime | computed on create |
| first_responded_at | datetime | nullable |
| resolved_at | datetime | nullable |
| closed_at | datetime | nullable |
| tags | m2m → tags | |

**Workflow**: new → open → pending → resolved → closed; reopen allowed (records event, reschedules SLA per D-04).

## ticket_events (APPEND-ONLY)
| Field | Type | Notes |
|---|---|---|
| ticket | m2o → tickets | required |
| event_type | enum | created, status_changed, assigned, commented, sla_warning, sla_breached, resolved, closed, reopened, automation_triggered |
| actor | m2o → users | nullable (null = system) |
| payload | json | previous + new values |

**Rule (FR-014)**: create + read only; **no update, no delete** for any role (enforced via Directus permissions, D-12).

## notifications
| Field | Type | Notes |
|---|---|---|
| recipient | m2o → users | required |
| type | enum | sla_warning, sla_breach, assignment, mention, ticket_update, reminder, escalation, automation |
| title | string | |
| body | text | |
| link | string | deep link into agent portal |
| read_at | datetime | nullable |
| channel_inapp_delivered_at | datetime | nullable |
| channel_email_delivered_at | datetime | nullable |
| payload | json | |

## sla_policies
| Field | Type | Notes |
|---|---|---|
| name | string | required |
| description | text | |
| applies_to_priority | json | array of priority values |
| first_response_minutes | integer | required |
| resolution_minutes | integer | required |
| warning_threshold_percent | integer | default 80 |
| business_hours | json | nullable (null = 24/7) |
| active | boolean | default true |

## automation_rules
| Field | Type | Notes |
|---|---|---|
| name | string | required |
| description | text | |
| trigger_event | enum | conversation_created, message_received, ticket_created, ticket_status_changed, sla_warning, sla_breach, inactivity, keyword_matched |
| conditions | json | array of `{ field, operator, value }` |
| actions | json | array of `{ type, ... }` — assign_agent, assign_team, set_priority, add_tag, send_notification, escalate, set_status |
| active | boolean | default true |
| priority | integer | execution order |
| last_triggered_at | datetime | nullable |
| trigger_count | integer | default 0 |

## reports
| Field | Type | Notes |
|---|---|---|
| name | string | required |
| description | text | |
| type | enum | conversation_volume, response_time, sla_compliance, ticket_resolution, agent_productivity, csat, vendor_activity |
| filters | json | vendor, agent, team, date range |
| schedule | json | nullable — `{ cron, recipients[] }` |
| last_run_at | datetime | nullable |
| created_by | m2o → users | |

## tags
| Field | Type | Notes |
|---|---|---|
| name | string | required, **unique** |
| color | string | |
| description | text | |

## custom_fields
| Field | Type | Notes |
|---|---|---|
| entity_type | enum | contact \| conversation \| ticket |
| name | string | required |
| key | string | required, **unique per entity_type** |
| field_type | enum | text, number, boolean, date, select, multiselect |
| options | json | nullable — for select/multiselect |
| required | boolean | default false |
| display_order | integer | |

## custom_field_values
| Field | Type | Notes |
|---|---|---|
| custom_field | m2o → custom_fields | required |
| entity_type | enum | contact \| conversation \| ticket |
| entity_id | uuid | required |
| value | json | type depends on custom_field.field_type |

## csat_responses
| Field | Type | Notes |
|---|---|---|
| conversation | m2o → conversations | required, **unique** (≤1 per conversation, SC-013) |
| contact | m2o → contacts | required |
| score | integer | 1–5 |
| comment | text | nullable |
| submitted_at | datetime | |

---

## Relationship summary

```
vendors 1─* contacts 1─* conversations 1─* messages
vendors 1─* tickets *─1 contacts
conversations 1─0..1 tickets        conversations 1─0..1 csat_responses
tickets 1─* ticket_events (append-only)
users *─1 teams                      notifications *─1 users (recipient)
tickets *─0..1 sla_policies
custom_fields 1─* custom_field_values ─(entity_type,entity_id)→ contact|conversation|ticket
tags *─* {contacts, conversations, tickets, messages-mentions via users}
```

## Indexing & integrity notes
- Indexes: `contacts.phone`, `contacts.email`, `conversations.last_message_at`, plus the per-vendor partial-unique constraints on contacts.
- All enums validated in `shared-types` Zod schemas so portals/services share one definition (no drift).
- `entity_id` in `custom_field_values` is a soft reference (validated against `entity_type` at write time, since it can point at three collections).
