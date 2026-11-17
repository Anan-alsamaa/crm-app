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
2. **`compensation.escalated` notifies the CRM roles mapped from V2's `escalate_to`, and the
   Administrator ALWAYS** (owner rule, 18 Nov 2026). The WeCare order is WeCare Agent -> WeCare
   Supervisor -> WeCare Admin -> Administrator (topmost, the master user). The mapping is the
   `app_settings` key `compensation_escalation_roles` (JSON `{ "<escalate_to>": ["<role name>",
...] }`), edited by the Administrator on the admin portal's Roles page ("Yiji V2 compensation
   escalations"). Defaults: "Operations Manager" -> `WeCare Supervisor`; "Relevant management" ->
   `WeCare Admin`. The `Administrator` receives every escalation whatever the mapping says (shown
   ticked and locked on the page). An `escalate_to` the mapping does not know goes to both WeCare
   manager roles (and the Administrator). Recipients are resolved by role **name** (never by
   privilege: the built-in Administrator role has no privilege list, so resolving by privilege
   reaches nobody, the recipients trap of `docs/GENERAL-COUPON-ALERT.md`). Mapped roles with no
   active user: logged, the Administrator is still told. Nobody active at all: an error log. To
   change: `DEFAULT_COMPENSATION_ESCALATION_MAPPING`, `COMPENSATION_ESCALATION_ALWAYS_ROLE` and
   `escalationRolesFor` in `packages/shared-types/src/yiji2-compensation.ts`.
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

### Review follow-ups (18 Nov 2026)

1. **Idempotency follows the request.** The portal's form makes one nonce when it opens; the key
   it sends is `yiji2RequestKey(nonce, { caseId, action, body })`. The gateway sends V2
   `yiji2RequestKey(<portal key>, { caseId, action, body: <what V2 receives>, reason })` (log:
   `{ action: 'log', body }`). An identical retry reaches V2 with the same key; a changed amount,
   reason, result or category is a new key, so V2 never answers it with the first request's stored
   result. Same rule for approve, reject, evidence, verification and log complaint.
2. **A case on another ticket.** When "Log V2 complaint" is answered with an existing case already
   linked to a different CRM ticket, the gateway answers 409 `case_on_other_ticket` with no case
   row; `ticketId` is included only when the caller may read that ticket. The panel says so in
   English or Arabic (`v2Case.error.otherTicket`, `otherTicketHidden`).
3. **The coupon code on the case.** A `coupon.granted` WITHOUT `pending_grant_id` now goes to the
   compensation job (never to the pending-grants job, never to `coupon_approvals`). Its `code` and
   `coupon_id` go on the case row with that `grant_id`. V2 sends the grant before
   `compensation.decided`, so the grant is first held in the workers' Redis for 30 days
   (`yiji2:compensation-grant:<vendor key>:<grant id>`); each side writes, then looks for the
   other, so the code lands whichever arrives first. A grant that matches no case (a CRM coupon's
   own grant) is only held until it lapses. A grant without `grant_id` or `code` is ignored, as
   before.

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
on the ONE `app_settings` row `compensation_escalation_roles`; svc-ai-gateway create/read/update on `compensation_cases` and read on `tickets`
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
2. **Sample payloads: received** (`docs/integrations/crm/auto-compensation-samples.md`, V2 main,
   printed by a V2 test run on 2026-11-18). All eleven are fixtures
   (`packages/shared-types/tests/fixtures/yiji2-compensation-samples.json`, copied verbatim) and
   run through the receiver and the worker job (section 7). Every one is accepted.
3. **`compensation.decided` carries `order_number`** in the real samples. The CRM still accepts
   one without it: the case is matched by `case_id`, and a stored `order_number` is never blanked.
4. **The 409 body.** The CRM reads `error.data.reason`; the document says `data.reason` without
   showing the envelope. Confirm it sits inside `error`.
5. **`agent_id` is the CRM user's UUID** (36 characters, within the 64 allowed).
6. **`escalate_to` words.** The mapping keys are "Operations Manager" and "Relevant management" as
   in rules.csv; any other word goes to both WeCare manager roles; the Administrator is told of every one. The sample of 2026-11-18 uses "Operations Manager".

## 7. Tests

**The real V2 samples** (2026-11-18): `services/socket-gateway/tests/yiji2-compensation-samples.test.ts`
(each sample signed and posted to `/webhooks/yiji2/events`: accepted, queued with its `data`
unchanged; the whole run in one batch with every key order reversed) and
`services/workers/tests/compensation-yiji2-samples.test.ts` (each sample through the receiver's
parser, a JSON round trip and the worker job: the case row, the ticket and the notifications; the
whole 11-event run ends with six rows and six tickets in the right states; key order does not
matter; a redelivery changes nothing). Also there:

- **Upsert** of the three `compensation.proposed` of case 3 in all six orders: one row, one ticket,
  ends `proposed` with SAR 15.00 and `has_photos` true. A released case never goes back to
  `evidence_hold` (V2 sends the same `occurred_at` in its test run, so time alone cannot order
  them), `has_photos` never goes back to false, and a decided case never moves back.
- **Ordering** of `coupon.granted` and `compensation.decided` of a coupon case (V2 sends the grant
  first): the same end state in both orders, the case matched by `case_id` and carrying
  `grant_id`/`coupon_id` from the decision. A compensation grant has no `pending_grant_id`, so the
  pending-grants job never sees it and no CRM coupon is touched (tested with a CRM coupon whose V2
  ids collide with the sample's).

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
