# Yiji v2 automatic compensation: the CRM side

Owner goal, 18 Nov 2026. Contract: yiji-platform
`docs/integrations/crm/auto-compensation-contract.md` (2026-11-17, second pass),
`api/openapi/partner-v1.yaml` (`/compensation-cases*`) and `api/openapi/crm-events-v1.yaml`
(`compensation.proposed`, `compensation.decided`, `compensation.escalated`).

**Tenant `yiji2` only, staging only.** The v2 vendor row stays inactive until the owner activates
it; the production guard (`docs/YIJI-V2-TENANT.md` section 4a) still blocks any release that
carries v2 code. Nothing changes for Yiji v1 tickets, coupons or customers. The CRM's own
`compensation_rules` stay as they are (V2 no longer reads them; not deleted).

## 1. The flow

| Step                                  | Who          | CRM piece                                                                                                          |
| ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| V2 opens a case (AUTO, app, or agent) | V2           | -                                                                                                                  |
| V2 tells the CRM                      | V2 -> CRM    | `POST /webhooks/yiji2/events` (signed, de-duplicated) -> coupons queue job `yiji2-compensation-event`              |
| The case gets a row and ONE ticket    | workers      | `services/workers/src/processors/compensation-yiji2-events.ts`                                                     |
| An agent decides on the ticket        | agent portal | `V2CompensationPanel` -> AI gateway `/commerce/compensation-cases/:id/approve` (or reject, evidence, verification) |
| The gateway calls V2                  | AI gateway   | `services/ai-gateway/src/commerce/compensation-cases.ts` -> `Yiji2CompensationCases` (connector)                   |
| V2 issues and messages the customer   | V2           | `compensation.decided` -> the row and the ticket's Compensation                                                    |
| An escalation                         | V2 -> CRM    | `compensation.escalated` -> notifications to the mapped roles                                                      |

Every case needs one agent approval. A case expires 72 hours after it was proposed (or after its
photos); the panel counts down to `expires_at`.

## 2. Design choices (proposed by V2; to confirm with the owner)

Each is one place in the code, so a change is small.

1. **One CRM ticket per V2 case, keyed by `case_id`.** V2 creates no CRM tickets. The case is a
   linked row (`compensation_cases.case_id`, unique), the ticket is the CRM's ordinary ticket under
   the v2 vendor (`external_id = compensation-case:<case_id>`, `complaint_source = Yiji`,
   `compensation = Initial` until decided). A case an agent logged from a ticket is linked to THAT
   ticket (the events job waits up to three tries, about 14 s, for the gateway to record it before
   it opens a ticket itself). To change: `openTicket` in the worker and `record` in the gateway.
2. **`compensation.escalated` notifies the CRM roles mapped from V2's `escalate_to`.** The mapping
   is the `app_settings` key `compensation_escalation_roles` (JSON `{ "<escalate_to>": ["<role
name>", ...] }`), edited by the Administrator on the admin portal's Roles page ("Yiji V2
   compensation escalations"). Default for both "Operations Manager" and "Relevant management":
   `WeCare Admin`, `WeCare Supervisor`, `Administrator`. Recipients are resolved by role **name**
   (never by privilege: the built-in Administrator role has no privilege list, so resolving by
   privilege reaches nobody, the recipients trap of `docs/GENERAL-COUPON-ALERT.md`). Mapped roles
   with no active user: the Administrator is told (logged). Still nobody: an error log. An
   `escalate_to` the mapping does not know goes to the default roles. To change:
   `DEFAULT_COMPENSATION_ESCALATION_ROLES` / `escalationRolesFor` in
   `packages/shared-types/src/yiji2-compensation.ts`.
3. **Events first; no V2 list route.** Agents see cases through their tickets and the ticket queue.
   The panel can re-read one case from V2 (`GET /compensation-cases/{id}`), and the gateway does so
   after every 409 so the panel shows the case as V2 has it.

## 3. Pieces

| Piece           | Where                                                                             | What it does                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contract | `packages/shared-types/src/yiji2-compensation.ts`                                 | AGENT codes, statuses, 409 reasons and their messages, the event job + mapper, the CRM row and its mappers, the override limits, money formatting, the escalation setting.                                        |
| Connector       | `packages/shared-types/src/yiji2-connector.ts` (`Yiji2CompensationCases`)         | `logComplaint`, `get`, `approve`, `reject`, `evidence`, `verification`; bodies checked locally first; `Idempotency-Key` required on every write; a 409's `error.data.reason` lands on `Yiji2RefusedError.reason`. |
| Mock            | same file, `MockYiji2Transport`                                                   | The case routes and state machine (fixed mock rules, not the owner's policy), emitting the three events in `events`. Helpers `seedCase`, `expireCase`, `failOnApprove`. Zero network.                             |
| Inbound         | `services/socket-gateway/src/yiji-inbound.ts`, `queue.ts`, `index.ts`             | `/webhooks/yiji2/events` accepts the three types (same signature and de-dup as every event); malformed = ignored and logged; unknown types still ignored.                                                         |
| Worker          | `services/workers/src/processors/compensation-yiji2-events.ts`                    | proposed -> row + ticket; decided -> decision, issued amount, wallet / coupon / grant ids, failure, ticket Compensation; escalated -> notifications. Idempotent; an older event never moves a decided case back.  |
| Gateway         | `services/ai-gateway/src/commerce/compensation-cases.ts`, `auth/session-actor.ts` | The caller's own Directus session decides who and what; the ticket must be readable with THEIR token; the case must be linked to that ticket; the v2 vendor must be active (else 404 `unknown_vendor`).           |
| Agent portal    | `apps/agent-portal/src/features/tickets/V2CompensationPanel.tsx`                  | On a v2 ticket: status, rule/occurrence, action type, amount or percent, calculation, minutes late, escalation banner, verification, countdown, photos/items/text; actions with reasons; "Log V2 complaint".      |
| Admin portal    | `apps/admin-portal/src/features/app-roles/CompensationEscalation.tsx`             | The escalation mapping (Administrator only).                                                                                                                                                                      |

### 409 reasons

| `data.reason`     | What the agent reads                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `closed`          | This case is already closed (rejected, expired or failed). Nothing more can be done.            |
| `expired`         | This case passed its 72 hours. It can no longer be approved.                                    |
| `evidence_hold`   | This case is waiting for photos. Check the photos, then use "Photos received" before approving. |
| `needs_bhd_value` | Yiji V2 has no Bahraini dinar value for this rule yet. The case can only be rejected.           |
| `failed`          | Yiji V2 could not issue the compensation (a coupon check refused it). The case is now failed.   |
| `not_held`        | This case is not waiting for photos.                                                            |
| `no_verification` | This case has no camera check to close.                                                         |

### The amount override

Approve only; wallet and amount-coupon cases only (a calculated `amount`, no `percent_bps`, not
APOLOGY_ONLY or VERIFY_CCTV); the order's currency; whole minor units above 0; not above the order
total. Checked in the portal, again in the gateway before any call, and by V2.

## 4. The new privilege

`approve_compensation_cases` (owner-only list, Coupons group, Agent portal). Off for every role by
default (`never`); the Administrator always holds it. It gates every action route and the
"Log V2 complaint" button. Its Directus grant is READ on `compensation_cases` only; every write goes
through the gateway (service account) or the workers. Mirrored in
`directus/extensions/app-roles-sync/index.js` (pinned by `privileges-mirror.test.ts`).

## 5. Schema step (owner, staging)

New collection `compensation_cases` (fields and relations in `directus/bootstrap/src/collections.ts`;
`case_id` unique, `ticket` -> tickets SET NULL, `vendor` -> vendors CASCADE). New grants in
`directus/bootstrap/src/roles.ts`: svc-workers create/read/update on `compensation_cases` and read
on `app_settings`; svc-ai-gateway create/read/update on `compensation_cases` and read on `tickets`
(`id`, `vendor`, `order_id`). Run on staging, in this order:

1. Schema (collection, fields, its two relations):
   `pnpm --filter @yiji/directus-bootstrap run apply:fields -- --only=compensation_cases`
2. Service-account grants, those two roles only:
   `pnpm --filter @yiji/directus-bootstrap run apply -- --roles-only=svc-workers,svc-ai-gateway`
3. The app-roles-sync extension change (the privilege's read grant) goes live with the next
   Directus restart (operational, the owner's step).

Until it is applied the events job fails and BullMQ retries (then the job is dropped and logged),
and the panel shows nothing; v1 is not affected either way.

## 6. What V2 must add or confirm

1. **`order_item_id` on the partner order read.** `OrderItem` in `partner-v1.yaml` has `item_id`
   (the catalogue id) but no line id, so the CRM cannot name `affected_items` when it logs a
   complaint. The gateway and the connector already take `affectedItems`; the panel offers the
   picker once the order read carries the line id. Until then an item-paid category is refused by
   V2 with its 400 and the agent sees the reason.
2. **Sample payloads** for the three events (as `pending-coupon-samples.md` did for pending
   coupons), so the mapper is checked against real bodies. Built from `crm-events-v1.yaml`.
3. **`compensation.decided` with no `order_number`?** The schema requires it; the CRM treats one
   without it as malformed (ignored, logged).
4. **The 409 body.** The CRM reads `error.data.reason`; the document says `data.reason` without
   showing the envelope. Confirm it sits inside `error`.
5. **`agent_id` is the CRM user's UUID** (36 characters, within the 64 allowed).
6. **`escalate_to` words.** The mapping keys are "Operations Manager" and "Relevant management" as
   in rules.csv; any other word goes to the default roles.

## 7. Tests

`packages/shared-types/tests/yiji2-compensation.test.ts` (events mapper, row mappers, merge rule,
override limits, money, 409 messages, escalation setting, privilege default, connector + mock state
machine, HTTP 409 reason), `services/socket-gateway/tests/yiji2-compensation-events.test.ts`
(signed, de-duped, malformed, unknown, 503, v1 route unchanged),
`services/workers/tests/compensation-yiji2-events.test.ts` (each event type, idempotency, order
safety, the gateway wait, escalation recipients incl. fallback and nobody, end to end with the
mock), `services/ai-gateway/tests/compensation-cases.test.ts` (each route, the privilege, ticket
visibility, v1 refusal, inactive vendor, override limits, 409 mapping and refresh, session
resolver), `apps/agent-portal/tests/v2-compensation-panel.test.tsx` (fields, actions, override,
409 text, Log V2 complaint, nothing on a v1 ticket).
