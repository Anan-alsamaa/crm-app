# Sara CRM — End-to-End System Guide

_For: the product manager / owner. Every statement is taken from the code as of v1.47.0 (2026-10-09). Paths are relative to the repo root._

**How to read:** §1–4 explain the system and its vocabulary. §5–13 trace each business flow step by step, with the endpoint, body and response at each step. §14–18 cover multi-vendor, configuration, the Yiji API reference, deployment and the tools we use. §19 lists the known issues found while writing this.

---

## 1. The system on one page

```
 Customer (Yiji app webview / QR page / website)           Agents & Admins (browser)
          │  chat widget (Preact)                     agent portal · admin portal (React)
          │  Socket.IO + HTTPS                              │ REST (Directus SDK) │ Socket.IO │ HTTPS
          ▼                                                 ▼                     ▼           ▼
 ┌──────────────── crm-api.anan.sa  (AWS ALB, path-routed) ───────────────────────────────────────┐
 │  /socket.io /chat /walk-in /webhooks /jobs /teams ─► socket-gateway (Fastify + Socket.IO)        │
 │  /commerce/*  /admin/config  AI endpoints        ─► ai-gateway     (Fastify + Gemini)           │
 │  everything else (/items /auth /files …)         ─► Directus 11    (data, auth, permissions)    │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
          │ BullMQ jobs (Redis)                          │ SQL                      │ HTTPS
          ▼                                              ▼                          ▼
     workers (BullMQ processors)  ──────────────►  Postgres (RDS)        Yiji APIs (orders, users,
     SLA · routing · coupons · push · reports      Redis (ElastiCache)    coupons, notifications)
```

| Component                                      | What it does                                                                                                            | Tech                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **chat-widget** (`apps/chat-widget`)           | Customer chat: Yiji webview, `walk-in.html` QR page, embeddable script                                                  | Preact + Vite                                           |
| **agent-portal** (`apps/agent-portal`)         | Agents' desk: inbox, chat, tickets, late orders, coupons, performance                                                   | React 18 + Vite, TanStack Query, i18next EN/AR          |
| **admin-portal** (`apps/admin-portal`)         | Approvals, reports, roles, users, vendors, lists, SLA, AI config, **Update now**                                        | same stack                                              |
| **socket-gateway** (`services/socket-gateway`) | Realtime hub; the **only writer of chat messages**; HTTP routes for sessions, uploads, jobs, webhooks, releases         | Fastify 5, Socket.IO 4 (Redis adapter), BullMQ producer |
| **workers** (`services/workers`)               | Background jobs: SLA, routing ladder, coupon delivery, customer push, notifications, reports, automation, imports       | BullMQ                                                  |
| **ai-gateway** (`services/ai-gateway`)         | AI endpoints (Gemini) + **commerce proxy** to Yiji (orders, cart, late orders)                                          | Fastify, `@google/generative-ai`                        |
| **Directus 11** (`directus/`)                  | The database API: every collection, users, roles, permissions; extensions add business rules                            | Directus + Postgres 16                                  |
| **Shared packages** (`packages/`)              | `shared-types` (contracts, Yiji client, connectors, SLA maths), `shared-config`, `ui`, `i18n`, `reports`, `order-views` | TypeScript                                              |

**Golden rules built into the design**

- Agents read/write data **directly in Directus** with their own token; Directus permissions are the security boundary.
- **Chat messages** are written only by the socket-gateway; **Yiji** is called only by the ai-gateway (reads) and workers (writes).
- Every change goes to **staging first**; production is a `v*` git tag plus the owner's approval; agent-facing screens wait for **Update now**.

---

## 2. Environments & URLs

|                           | Staging                                 | Production                                                                |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| API (Directus + gateways) | `crm-api-staging.anan.sa`               | `crm-api.anan.sa`                                                         |
| Agent portal              | `crm-agent-staging.anan.sa`             | `crm-agent.anan.sa`                                                       |
| Admin portal              | `crm-admin-staging.anan.sa`             | `crm-admin.anan.sa`                                                       |
| Chat widget               | `crm-staging.anan.sa`                   | `crm.anan.sa`                                                             |
| ECS cluster               | `crm-staging` (1 task each)             | `crm-prod` (directus 2, gateway 2, ai 1, workers 1; autoscale at 70% CPU) |
| Coupon delivery to Yiji   | **off** (`YIJI_COUPON_DELIVERY` ≠ `on`) | on                                                                        |
| Mock vendors              | allowed (`ALLOW_MOCK_VENDORS=true`)     | refused (services refuse to start)                                        |

AWS account 408568863712, region us-east-2. Staging uses **Yiji's production APIs** for reads; coupon/push writes are blocked or redirected to a test handset.

---

## 3. Data model (Directus collections that matter)

| Collection             | Key fields                                                                                                                                                                                                                                                               | Notes                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `vendors`              | name, `yiji_vendor_id`, status, `platform` (yiji/mock), `api_base_url`, `admin_api_url`, `tenant_id`, `brand_id`, `notify_settings`, `webhook_path_key`                                                                                                                  | Only the Administrator edits; others see display fields                            |
| `brands` → `stores`    | code, name, `yiji_brand_name` / `yiji_restaurant_id`, city, managers, `vendor`                                                                                                                                                                                           | "Branch" = store                                                                   |
| `contacts`             | vendor, `external_customer_id` (Yiji user id), name, phone (`05…`), email, `acquisition_channel`                                                                                                                                                                         | Unique per vendor by phone / email                                                 |
| `conversations`        | vendor, contact, status `open`/`solved`, priority, `assigned_agent`/`team`, `initiated_by` (customer/agent), `session_started_at`, `first_response_due_at` / `first_responded_at` / `first_response_breached_at`, `unread_count_agent`, `last_order_id`, `csat_response` | **One conversation per contact**; a new message reopens a solved one               |
| `messages`             | conversation, `sender_type` (customer/agent/system), sender, content, `is_internal_note`, edited/deleted + `original_content`, **`source`**, `quick_reply_id`, `source_text`, `source_edited`                                                                            | `source` records where the words came from (typed, quick reply, AI, auto-welcome…) |
| `tickets`              | status `pending`/`solved`, priority, `complaint_type`, `service_type`, `complaint_source`, `communication_method`, `order_id` + `order_snapshot`, `store` + `store_snapshot`, `assigned_agent`, `sla_policy`, `resolution_due_at`, `resolved_at`, coupon fields, vendor  | Branch is mandatory in the form                                                    |
| `ticket_events`        | ticket, actor, `event_type`, payload                                                                                                                                                                                                                                     | Append-only history (largest table)                                                |
| `coupon_approvals`     | code, title, type, category, value/percent/cap, validity, usage, reason, `delivery_excluded`, status, `yiji_coupon_user_id` / `yiji_coupon_id` / `yiji_push_error` / `yiji_pushed_at`, `awaiting_signup_at`, vendor                                                      | Statuses: pending · edited · approved · rejected · assigned                        |
| `late_order_decisions` | `order_id`, `kind`, `action` (commented/compensated), reason, `action_taken`, `minutes_elapsed`, ticket, vendor                                                                                                                                                          |                                                                                    |
| `sla_policies`         | `governs` (chat/ticket), `first_response_minutes`, `resolution_minutes`, `warning_threshold_percent`, `business_hours`, scope lists, vendor                                                                                                                              |                                                                                    |
| `quick_replies`        | label, text, lang, `kind` (chat / late_order_reason / late_order_action), active, vendor (empty = all)                                                                                                                                                                   | Also holds the welcome template                                                    |
| `app_roles`            | name, `privileges` (JSON), brands, stores                                                                                                                                                                                                                                | Synced into real Directus roles                                                    |
| `ai_calls`             | endpoint, model, status, tokens (input/output/thinking), `est_cost_usd`, latency, user, vendor, conversation                                                                                                                                                             | Every AI call                                                                      |
| `routing_events`       | conversation, agent, outcome (answered/missed), stage, `seconds_held`                                                                                                                                                                                                    | Routing ladder audit                                                               |
| Others                 | `notifications`, `store_notifications` + `store_notify_rules`, `csat_responses`, `walk_in_links`, `option_lists`, `app_settings`, `reports`, `teams`, `tags`, `custom_fields`                                                                                            |                                                                                    |

---

## 4. Identity & permissions

**People**

- **Administrator** (the owner) — Directus `admin_access`; sees everything, including owner-only switches, vendors, AI config, Update now.
- **Admin / Agent** — built-in roles. **App roles** (WeCare Agent, WeCare Admin, WeCare Supervisor, Department Manager, Operations, Area Managers…) are rows in `app_roles`; the `app-roles-sync` Directus extension turns each saved row into a real Directus role + policy + permissions. It never grants `admin_access`, and a role editor cannot grant privileges they don't hold.
- **Privileges** (`packages/shared-types/src/privileges.ts`): chat, tickets, coupon approval, dashboards, export/import, lists, users, SLA, roles… plus **29 owner-only switches** visible only to the Administrator. Unset switches fall back to the old role-name behaviour.
- **Staff login** by employee ID: `4417` becomes `4417@staff.example.com` behind the scenes.
- **Per-tab sessions**: a new browser tab starts signed out (two agents can share a PC).

**Services** — static Directus tokens: `SVC_GATEWAY_TOKEN`, `SVC_WORKERS_TOKEN`, `SVC_AI_TOKEN` (ai-gateway is read-only except its `ai_calls` log).

**Customers** — a JWT (HS256, 12 h) signed with **the claimed vendor's own secret** (Yiji: `YIJI_JWT_SECRET`; other vendors: `VENDOR_<KEY>_JWT_SECRET`). A token for vendor B signed with Yiji's secret is rejected.

---

## 5. Flow A — a customer chat, end to end

### A1. Getting a chat token

**`POST /chat/session`** (same handler: `/walk-in/session`, `/walk-in/chat-session`) — no auth, 5 req then 1 per 30 s per IP.

```json
// body (only phone required)
{ "phone":"0501234567", "vendorId":"1", "customerId":"<yiji user guid>", "name":"…",
  "entryPoint":"app" | "store_qr", "orderId":"1334028", "yijiSessionToken":"…" }
// or a personal walk-in link
{ "code":"ABCDE12345" }
// response
{ "ok": true, "token": "<JWT>" }   // claims: vendor_id, customer_id, phone, name, walk_in, entry_point, order_id
```

- **Yiji app webview**: the app opens the page with `?token=…`. If it is Yiji's own session token, the gateway reads its user id and calls Yiji `GET /api/User/GetUserById/{id}` → phone, name, email.
- **Walk-in QR**: `walk-in.html` posts the phone (or `?c=CODE`) to `/walk-in/session`. Admins mint personal links with `POST /walk-in/link {phone, vendorId, days≤30}` → `{code, expiresAt, path}`. `?vendor=<id>` selects the vendor (default Yiji).
- Errors: unknown vendor 404, vendor without a secret 503, bad code 401, rate limit 429.

### A2. Connecting (Socket.IO)

`io(url, { auth: { token, lazyConversation:true, resumeConversationId? } })` — WebSocket first; the Yiji webview has no WebSocket, so it **polls**. Because polling isn't sticky behind the load balancer, **file uploads use a plain HTTP call**: `POST /chat/attachment?filename=&type=` (Bearer customer token, raw bytes) → `{ok, id, type, filesize}`.

On connect the server: verifies the token → resolves the vendor (`vendors.yiji_vendor_id`, active) → **upserts the contact** (per vendor, by phone or email; links the Yiji id when first proven) → finds the customer's existing conversation (open **or solved**; no new one is created yet).
Server → customer: `ready {conversationId|null, branding, vendorName, agentsOnline, contact, isNew, agentInitiated}`, `messages:history` (≤200), `customer:latest-order {orderId}` (for the WhatsApp fallback).

### A3. The customer sends the first message

Client → server: **`message:send`** `{conversationId?, content, attachments?: [fileId], clientMsgId}`

1. Rate limit + schema check.
2. **Conversation**: create `{vendor, contact, status:'open', priority:'medium', initiated_by:'customer', entry/last order}` — or reuse the existing one; a **solved** one is **reopened** (`status:'open'`, `solved_at:null`, first-response fields cleared, `session_started_at = now`).
3. **Message row** written with `source:'customer'`; `unread_count_agent` +1; `last_message_at` updated.
4. Broadcast `message:new` to the conversation room and `inbox:activity` to all agents.
5. **Automatic welcome** (new chat or new session, never for agent-started chats): template = active quick reply labelled "رسالة ترحيب"/"welcome message", language detected from the customer's text; saved as an agent message **without a user** (`source:'auto_welcome'`); it does **not** stop the first-response clock.
6. **Offline notice** — shown by the widget itself (not stored) when no agent is online; removed when a real agent replies.
7. **Routing job** queued (§A4) and automation rules run.

### A4. Who gets the chat — the routing ladder (`services/workers/src/routing.ts`)

| Stage       | What happens                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `assign`    | Pick the least-loaded eligible agent (team → whole roster) → set `assigned_agent`, notify them; check again in **60 s** |
| `escalate`  | If an agent replied → done (`routing_events: answered`). Else `missed` → next agent, check in **30 s**                  |
| `broadcast` | Release to the pool (`assigned_agent = null`), alert all eligible agents and supervisors (`no_agent`)                   |
| `reclaim`   | Agent disconnected/logged out → after **90 s** without them back, reassign or release                                   |

An unassigned chat is claimed automatically by the first agent who replies.

### A5. The agent replies

Agent portal → **`message:send`** `{conversationId, content, clientMsgId, origin?}` where `origin = {source:'quick_reply'|'ai_suggestion'|'ai_enhance', quickReplyId?, text}`.

- Stored with `source` (`typed` / `quick_reply` / `ai_suggestion` / `ai_enhance`), `source_text`, `source_edited` (did the agent change it).
- **First response** stamped here and only here (`first_responded_at`, only if empty); `unread_count_agent` → 0.
- Other agent events: `note:add {content, mentions}` (internal note; each active @mentioned colleague gets an in-app `mention` notification linking to the chat), `message:edit` / `message:delete` (own message, 15 min; deletes keep `original_content`), `typing:start/stop`, `read:ack`.

### A6. The customer isn't looking — push notification

If no customer socket is in the room, a **customer-push** job is queued: `{conversationId, phone, externalCustomerId, preview (140 chars), sentAt, vendorId}`. The worker calls Yiji:

```json
POST https://notificationsystems.yiji-app.com/api/NotificationData/SendCrmNotification
{ "userId":"<yiji id>", "phoneNumber":"+9665…", "tenantId":1, "brandId":1,
  "title":"Yiji Support", "body":"<agent text>",
  "data": { "prop1":"crm.openchat", "conversationId":"…", "source":"sara-crm" } }
```

`brandId` comes from the customer's latest order. A permanent refusal ("Customer not found") marks the chat **push-unreachable** and the agent sees a **WhatsApp** prompt instead.

### A7. Closing and CSAT

- **Manual**: agent PATCHes the conversation `{status:'solved', solved_at}` in Directus, then emits `conversation:updated` → gateway sends `conversation:closed` → the widget shows the **CSAT** survey.
- **Idle close**: a sweep (Redis-locked) closes quiet chats after the configured minutes with a farewell system message (skips agent-started chats where the customer never replied).
- **CSAT**: `csat:submit {conversationId, score 1-5, comment?}` → `csat_responses` row (one per conversation).
- The customer writing again **reopens the same conversation** as a new session (A3 step 2).

### A8. Socket event reference

| Client → server                                                                                                                                                                                                                       | Server → client                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message:send`, `note:add`, `note:delete`, `message:edit`, `message:delete`, `typing:start/stop`, `read:ack`, `csat:submit`, `conversation:subscribe`, `conversation:updated`, `agent:logout`, `attachment:upload` / `attachment:get` | `ready`, `messages:history`, `conversation:ready`, `message:new`, `message:edited`, `message:deleted`, `note:new`, `note:deleted`, `typing:update`, `inbox:activity`, `conversation:changed`, `conversation:closed`, `presence:update`, `agents:presence`, `notification:pushed`, `customer:latest-order`, `error {code, message}` |

---

## 6. Flow B — an agent starts the chat

1. **`POST /chat/agent-initiate`** (Bearer agent token, needs `start_chats`) `{phone, vendorId}` → `{ok, conversationId, contactId, created, contactIsNew, name, phone}`. Creates the contact/conversation with `initiated_by:'agent'`; writes no message.
2. The portal subscribes and sends the first message via `message:send`.

- Agent-started chats get **no greeting**, are **excluded from the first-response SLA**, and are not idle-closed until the customer answers. Reports show them under **"Started by: Agent"**.

---

## 7. Flow C — orders shown to agents (commerce proxy)

The portal never calls Yiji directly; it calls the ai-gateway with the agent's token:

| Request                                             | Returns                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /commerce/inbox?vendorId&customerId&limit≤10`  | `{data:{orders, detail}}` — list + the newest order in full (504 if Yiji is slow, never a fake empty list) |
| `GET /commerce/order?vendorId&orderId`              | one order: status, payment, items **with add-ons**, branch, totals, customer phone                         |
| `GET /commerce/orders?vendorId&customerId&limit≤50` | the customer's orders                                                                                      |
| `GET /commerce/cart?orderId&vendorId`               | cart lines + add-ons, fees, discount, tax, tracking link                                                   |
| `GET /commerce/tracking?vendorId&orderId`           | status timeline                                                                                            |
| `GET /commerce/late-orders?…&vendorId`              | late-orders queue (§10)                                                                                    |
| `GET /commerce/customer-exists?phone&vendorId`      | whether the phone has a Yiji account                                                                       |

Example order (production #1334028):

```json
{
  "orderId": "1334028",
  "status": "closed",
  "total": 57,
  "currency": "SAR",
  "items": [
    {
      "name": "Buffalo Pasta Combo",
      "qty": 1,
      "price": 35,
      "category": "Combos",
      "modifiers": ["Pepsi"]
    },
    {
      "name": "Makrona Hamra",
      "qty": 1,
      "price": 18,
      "category": "Original Pasta",
      "modifiers": ["Regular Size with Chicken"]
    }
  ],
  "restaurantName": "Jeddah - North Avenue",
  "brandName": "La Casa Pasta",
  "deliveryType": "pickup",
  "paymentStatus": "paid",
  "paymentMode": "apple_pay",
  "customerPhone": "0565745549"
}
```

Add-ons come from Yiji's `orderItems[].extraModifiers[].elements[]`. Unknown vendor → 404 `unknown_vendor`.

---

## 8. Flow D — tickets

**Ways in**

1. **From a chat** (`CreateTicketDialog`) — links the conversation, copies chat files, assigns the current agent, can attach a coupon request.
2. **Add-ticket page** `/new-ticket` (needs `create_tickets`) — same form without a chat; the draft is kept if you leave the page.
3. **Spreadsheet import** (admin → Agent KPI → Tickets, needs `import_data`) — parsed in the browser with a preview (new / already loaded / repeated / skipped / unmatched branches); imported rows are `solved`.

**What is saved** — status `pending`, complaint fields, `order_id` + an `order_snapshot`, `store` + a frozen `store_snapshot` (branch is mandatory), priority, assigned agent, vendor.
**After saving**

- `ticket_events` history: created, status_changed, assigned, commented (with @mentions), contacted (WhatsApp), sla_warning / sla_breached / sla_escalated, resolved.
- **Branch notification**: if the complaint type has an enabled rule (`store_notify_rules`), a `store_notifications` row is queued for the branch _(delivery waits on a POS integration — see §19)_.
- **Agent notifications** (`notify-on-change` extension): assignment, status change, high-value coupon request, and **@mentions in a comment** ("<name> mentioned you on a ticket", links to the ticket). `POST /jobs/notify-assignment` lets staff notify a colleague. Each user chooses in-app / email / both / none per type.
  Statuses: **Pending** and **Solved** only.

---

## 9. Flow E — coupons (compensation)

### E1. Agent requests

Form `CouponRequestDialog` (from a ticket, chat or late order) creates a `coupon_approvals` row (status `pending`). Defaults: title = customer phone, code = `<SIDE>-XXXXXXXX` (CC, OPS, MKT…), type **Private**, category **Amount**, validity one month, 1 use, **Assign the coupon on Yiji: Yes / No, don't assign to customer** (`delivery_excluded`).
Rules (`couponTermsProblems`): Amount → value > 0 and **cap = value**; Percentage → percent > 0 and a cap > 0; end date ≥ start date.

### E2. Admin approves (`/coupon-approvals`, needs `approve_coupons`)

- Approve (one click) / Reject (reason required) / Edit terms (an edited approval becomes `edited`).
- Approve is blocked only if the coupon is to be assigned but has neither an order nor a phone.
- On approve: ticket updated → row `{status:'approved'|'edited', decided_by, decided_at}` → **`POST /jobs/coupon-push {couponApprovalId}`** queues delivery. **Retry** clears the error and queues again.

### E3. Delivery to Yiji (worker `coupon-push.ts`) — four routes

| Route  | When                                     | Yiji calls                                                                                                                                           | Result                                                                                                    |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **1a** | has an order                             | `GetOrderAsync` (to learn the Yiji user, branch, brand) → **`POST /api/CouponUserOrder/CreateCouponUserFromOrder`**                                  | `assigned` + `yiji_coupon_user_id`                                                                        |
| **1b** | no order, phone has a Yiji account       | `GetfilteredCustomers?PhoneNumber=5XXXXXXXX` (exactly one exact match) → **`POST /api/Coupon/AddCoupon`** → **`POST /api/CouponUser/AddUserCoupon`** | `assigned`                                                                                                |
| **2**  | "No, don't assign" (`delivery_excluded`) | **`AddCoupon`** only (`assignee: []`)                                                                                                                | stays `approved`, `yiji_coupon_id` saved                                                                  |
| **3**  | phone has no Yiji account yet            | none — held                                                                                                                                          | `awaiting_signup_at`; re-checked every 10 min (day 1), hourly (to day 7), daily; expires after `valid_to` |

**Request body (route 1a)** — fixed values: `orderMaximum 1000000`, `reachLimit 10000`; name = `+966` phone; description prefixed **`CRM - `**.

```json
{
  "id": 0,
  "orderId": 1323407,
  "usedAmount": 0,
  "status": 0,
  "couponUser": {
    "couponCode": "CC-7KQ2MZPA",
    "couponName": "+966540041059",
    "compensationReason": "CRM - Late delivery",
    "userId": "<guid>",
    "customerPhone": "+966540041059",
    "coupon": {
      "name": "+966540041059",
      "code": "CC-7KQ2MZPA",
      "type": 1,
      "category": 1,
      "discount": 25,
      "discountPercentage": 0,
      "maximumDiscount": 25,
      "reachLimit": 10000,
      "limitForUser": 1,
      "monthlyReachLimit": 1,
      "orderMinimum": 0,
      "orderMaximum": 1000000,
      "issuingSideId": 8,
      "deliveryTypes": [3, 1, 2, 4, 5],
      "saturday": true,
      "…": "every weekday true",
      "restaurantId": 107,
      "brandId": 1,
      "activationDate": "2026-10-09T00:00:00",
      "expirationDate": "2026-11-09T23:59:00"
    }
  }
}
```

Codes: `type` General 0 / **Private 1**; `category` Percentage 0 / **Amount 1**; `deliveryTypes` delivery 1, pickup 2, carhop 3, dine-in 4, takeout 5; `issuingSideId` CC 8, OPS 6, MKT 3, Shadh 28, Taker 11, Shurouq 22, Leajlak 13, Parcel 20.
Headers: `Authorization: Bearer <admin login>`, `tenantid: 1`, `idempotency-key: <coupon code>`.

**Responses**: success `{"result":1,"exceptionMessage":"0","extendedProperties":{"CouponUserId":21486}}`; refusal HTTP 400 `{"result":2,"exceptionMessage":"User already have this coupon"}`; AddCoupon returns `"exceptionMessage":"couponId 73900"`.
**Refusal vs outage**: on a refusal the worker first **reads the customer's coupons back** (`GetCouponByUser`) — if the customer holds it, it's recorded as delivered; otherwise `yiji_push_error` is saved (no automatic retry). Outages (5xx/timeouts) retry 5× with backoff and write nothing.
**Safety net**: a delivery sweep every 60 s re-queues approved rows with no receipt and no error.
**Staging**: delivery off; redirect phones send everything to a test handset; services refuse to start if redirects point at production.

**Status meanings**: `pending` (waiting for admin) → `approved`/`edited` (approved, being delivered or withheld) → `assigned` (customer holds it on Yiji) · `rejected`.
Note: a coupon the customer **used** disappears from their Yiji wallet — that is normal, not a loss.

---

## 10. Flow F — late orders

- **Queue** (`GET /commerce/late-orders`): ai-gateway calls Yiji `GetFilteredOrders?DeliveryTypeIds=1&WithTotalServicesTimeFilterActive=<minutes>&OrderFromDateFilter=<day>&OrderToDateFilter=<day+1>&PageSize=500` and keeps live statuses (2,3,4,5,7,8,65) on delivery orders. Threshold = `app_settings.late_delivery_minutes` (default 60). Yiji times are Riyadh local without a zone — the CRM converts them. Business day = 08:00 → 08:00. The agent page refreshes every 30 s.
- Row: `{orderId, status, minutesElapsed, live, placedAt, closedAt, brandName, restaurantName, customerName, customerPhone, total}`.
- **Decision** (`late_order_decisions`): agent records **Commented** (reason) or **Compensated** (reason + action taken). Reasons/actions come from late-order quick replies; the **cause** (`kind`) from `option_lists.late_order_cause` — _operations_ causes also create a solved ticket.
- **Compensation**: opens the coupon form pre-filled (order, phone, items, reason) → delivered by **route 1a**.

---

## 11. SLA & working hours

- **Policies** (`/sla`): **Chat first response = 2 min**, **Ticket resolution = 60 min**, both with **working hours 09:00–04:00 Riyadh every day** (stored as two windows per day: 00:00–04:00 and 09:00–24:00). The clock pauses outside working hours — a 05:35 message is due 09:02.
- **Engine** (`workers/src/processors/sla.ts`, every 60 s):
  - **Chats**: sets `first_response_due_at` from the session start; when passed without a reply → `first_response_breached_at` + notify (agent → team → supervisors).
  - **Tickets**: attaches a policy, sets `resolution_due_at`, schedules a **warning at 80 %** and a **breach**. Breach → `sla_breached` event, priority raised to **urgent**, escalation notice to the team. A timer whose deadline has since moved stands down.
- **Reports** count durations in **working time** too (`businessMsBetween`), so night waits don't inflate KPIs; "waiting for" counters stay real-time.

---

## 12. Reports & dashboards

| Where                                                                                       | What                                                                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Admin `/dashboard`                                                                          | Operations (branches) + Agent tabs                                                                          |
| `/reports/agent-kpi/tickets` · `/sla` · `/conversations` · `/late-orders` · `/compensation` | Agent KPIs, SLA met/breached + open tickets, chats (incl. **Started by**), late orders, every coupon issued |
| `/reports/operational-kpi/tickets`                                                          | Ticket breakdown + **Import**                                                                               |
| `/coupon-report`                                                                            | Approval rates per agent                                                                                    |
| `/reports/scheduled`                                                                        | Saved reports: `POST /jobs/report {reportId}` → worker builds CSV and emails it; cron schedules             |
| Agent portal `/performance`                                                                 | Own KPIs; tabs **Chats / Tickets / Coupons**; search by customer number, ticket id or title                 |

Exports: XLSX/CSV (needs `export_data`). A vendor filter appears on reports once there are 2+ vendors.

---

## 13. AI

**Endpoints** (ai-gateway, Bearer agent token): `/summarize-conversation` → `{summary}` · `/suggest-reply` (with `draft` = **Enhance**) → `{reply}` · `/analyze-sentiment` · `/detect-intent` · `/extract-entities` · `/semantic-search` · `/score-lead` · `/help-assistant` ("Aura" in-app help).

```json
POST /suggest-reply {"conversationId":"<uuid>","draft":"sorry for delay","locale":"ar"}  →  {"reply":"…"}
```

**Each call passes**: feature flag → cache (15 min) → rate limits (IP 60 / user 20 / global 120 per minute) → monthly cap per vendor → (help) daily quota. Personal data (email, phone, card, IBAN, address) is **replaced with placeholders before Gemini sees it** and restored in the answer.
**Model**: Gemini 2.5 Flash (free tier today), temperature 0.4. **Every call is logged** in `ai_calls` with tokens and an estimated cost at the paid list price. Budget workbook: `docs/ai/ai-cost-estimate.xlsx`.

---

## 14. Multi-vendor

- **Connector per platform**: every Yiji call goes through a `VendorConnector` chosen from the record's vendor (`vendors.platform`: `yiji`, or `mock` on staging only). Unknown/unsupported → refused, never sent to Yiji.
- **Settings** (non-secret) come from the vendor record (API URLs, tenant, brand, notify settings), falling back to service settings; **secrets stay in service configuration**: Yiji `YIJI_*`; others `VENDOR_<KEY>_JWT_SECRET`, `_WEBHOOK_SECRET`, `_API_KEY`, `_ADMIN_EMAIL`, `_ADMIN_PASSWORD` (`docs/VENDOR-SECRETS.md`).
- **Webhooks**: `POST /webhooks/<webhook_path_key>` with headers `x-yiji-signature` (HMAC-SHA256) + `x-yiji-timestamp`, verified with that vendor's own secret → 202; wrong signature 401; unknown vendor 404; no secret 503.
- **Isolation**: every record carries its vendor; customers are unique per vendor; one agent receives every vendor's chats, a customer never sees another vendor's events; quick replies and SLA policies can be per vendor; AI limits/settings follow the chat's vendor.
- **Only the Administrator** manages vendors (enforced in the database).
- **Test Vendor** (staging, platform mock) proves all of this end to end. Onboarding a real vendor: write its connector → set its secrets → fill its Integration settings → run release checks (`docs/MULTI-VENDOR.md`).

---

## 15. Admin configuration (admin portal)

| Page                                                   | Purpose                                                                           | Who                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------- |
| `/roles`                                               | App roles and privilege switches (owner sees 29 extra)                            | `manage_roles`                          |
| `/users`                                               | Staff, role, team, status                                                         | `manage_users` (delete: `delete_users`) |
| `/vendors`                                             | Vendors + Integration settings                                                    | Administrator only                      |
| `/lists`                                               | Dropdown lists + **quick replies** (chat / late-order reason / late-order action) | lists privilege                         |
| `/sla`                                                 | SLA policies and working hours                                                    | `manage_sla`                            |
| `/coupon-approvals`                                    | Approve / reject / edit / retry coupons                                           | `approve_coupons`                       |
| `/store-notifications`, `/brands`, `/stores`, `/teams` | Branch notification rules and master data                                         | respective privileges                   |
| `/ai-config`                                           | AI feature flags, caps, per-vendor overrides                                      | Administrator only                      |
| `/backup`                                              | Backups                                                                           | `manage_backup`                         |
| **Update now** banner                                  | Releases the parked agent portal + widget build                                   | Administrator only                      |

---

## 16. Yiji API reference

| Call                                                                  | Host                | Used for                                                                           |
| --------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `POST /api/Account/login {email,password}` → `{token}`                | admin               | Bearer for every admin call (cached, re-login on 401)                              |
| `GET /api/Order/GetOrderAsync/{id}`                                   | order               | One order (status, items + `extraModifiers`, payment, branch, `userId`, `brandId`) |
| `GET /api/Order/GetOrderByUser/{userId}`                              | order               | Customer's orders                                                                  |
| `GET /api/Order/GetOrderCart/{id}`                                    | admin               | Cart, fees, tracking URL                                                           |
| `GET /api/Order/GetFilteredOrders?…`                                  | admin               | Late orders                                                                        |
| `GET /api/OrderStatusHistories/GetOrderStatusHistoriesByOrderId/{id}` | admin               | Timeline / service times                                                           |
| `GET /api/User/GetfilteredCustomers?PhoneNumber=5XXXXXXXX`            | admin               | Phone → Yiji user                                                                  |
| `GET /api/User/GetUserById/{id}`                                      | admin               | App session → phone, name                                                          |
| `GET /api/CouponUser/GetCouponByUser/{userId}?PageSize=500`           | admin               | Coupon read-back (unused coupons only)                                             |
| `POST /api/CouponUserOrder/CreateCouponUserFromOrder`                 | admin               | Coupon route 1a                                                                    |
| `POST /api/Coupon/AddCoupon`                                          | admin               | Coupon routes 1b, 2                                                                |
| `POST /api/CouponUser/AddUserCoupon`                                  | admin               | Coupon route 1b                                                                    |
| `POST /api/NotificationData/SendCrmNotification`                      | notificationsystems | Chat reply push                                                                    |

Hosts: `order.yiji-app.com`, `admin.yiji-app.com`, `notificationsystems.yiji-app.com`. The CRM's Yiji account is role "agent 1": coupon edits/removals are forbidden to it (by design).

---

## 17. Deployment & release

### 17.1 The path of a change

```
code → commit (pre-commit lint) → push main → CI + Deploy to ECS (staging) → release checks green
     → owner approves → git tag vX.Y.Z → Deploy to ECS (prod, approval gate) → release checks
     → admin portal live at once; agent portal + widget PARKED → owner presses "Update now"
```

### 17.2 GitHub Actions

- Runners are pinned to `ubuntu-24.04` and every action is on its Node 24 major, so GitHub platform changes cannot fail jobs unannounced.
- **CI** (`ci.yml`): lint, format, typecheck, security guard, unit tests with coverage; Playwright E2E against a real Directus; AI/commerce auth-contract test.
- **Deploy to ECS** (`deploy-ecs.yml`, AWS access via GitHub OIDC, no keys stored):
  1. **gate** — `pnpm verify`.
  2. **plan** — push to `main` → staging (tag `main`, build); tag `v*` → production (no rebuild: the tested image is re-tagged, same digest).
  3. **build** — 5 images → ECR `crm/{directus,socket-gateway,ai-gateway,workers,bootstrap}`.
  4. **portals** — build both portals + widget, write `config.js`, sync to S3; on prod the agent portal and widget go to `pending/` (+ `release.json`), the admin portal goes live; CloudFront cache cleared.
  5. **approve** — production requires the owner's approval.
  6. **deploy** — Directus first, then the other three; each new task definition is **copied from the live one** with only the image changed (so env settings persist); waits until stable.
  7. **smoke** — health, config, browser-style CORS check for photo upload.
  8. **release checks** — `scripts/release-check/regressions.mjs` (every environment, read-only on prod: coupons, SLA, schema fields, vendors, isolation, recording…), `chat-roundtrip.mjs` (staging: a real chat incl. photo, edit/delete, quick-reply recording), `staff-permissions.mjs` (staging: a test WeCare Agent's rights).
- **Update now**: admin portal → `POST /jobs/releases/apply` → gateway copies `pending/` over live in S3 and clears CloudFront; versions tracked in `app_settings`. Open agent tabs show a reload prompt within 5 min. `scripts/check-portal-promoted.mjs` shows whether something is waiting.

### 17.3 Database schema changes (manual, before the deploy)

New fields **do not** travel with a deploy. Run, per environment, **before** releasing:
`pnpm --filter @yiji/directus-bootstrap run apply:fields -- --only=<collections>` (fields only; a full `apply` rewrites roles — never on prod). Then verify each field with `GET /fields/<collection>/<field>`, add any permission rows, run backfill scripts, then release.

### 17.4 AWS

ECS Fargate (`crm-staging`, `crm-prod`) · ECR · RDS Postgres (shared) · ElastiCache Redis `redis-yiji` (namespaces `yiji` / `yiji-staging`) · S3 (portals, widget, uploads) behind CloudFront · ALB `crm-alb` with path rules · own NAT gateway in the shared VPC. Secrets live as plaintext env vars in task definitions (accepted risk — SSM/Secrets Manager are denied on the account). **Any AWS change needs the owner's approval.**

---

## 18. Tools we use

| Tool                                                                       | Used for                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub** (`Anan-alsamaa/crm-app`)                                        | Code, pull/push, Actions (CI + deploy), environment approval gate, `gh` CLI                                                                                                                                                                   |
| **AWS** (ECS, ECR, S3, CloudFront, ALB, RDS, ElastiCache, CloudWatch Logs) | Hosting and logs (`/ecs/crm-<env>/<service>`)                                                                                                                                                                                                 |
| **Directus 11**                                                            | Data API, auth, roles; Directus app for raw data (Administrator)                                                                                                                                                                              |
| **Linear** (`linear.app/crm-prod`, `EMA-*`)                                | Issue tracking. Labels: **Entered by** (who raised it), **Shipped to** (`PRODUCTION` / `STAGING only`), type (Enhancement / Technical issue). Projects: _Public – WeCare_ (operational) and _Technical – engineering reference_               |
| **pnpm** monorepo, **TypeScript** strict, Node 20                          | Build and code                                                                                                                                                                                                                                |
| **Vitest**, **Playwright**                                                 | Unit and end-to-end tests (`pnpm verify` runs the full gate)                                                                                                                                                                                  |
| **ESLint + Prettier** via husky/lint-staged                                | Pre-commit: zero warnings allowed                                                                                                                                                                                                             |
| **Git worktrees**                                                          | Parallel work streams on separate branches                                                                                                                                                                                                    |
| **Claude Code**                                                            | Engineering assistant (code, releases, investigations); keeps a project memory                                                                                                                                                                |
| **crm-mcp** (`tools/crm-mcp`)                                              | Read-only **production** connector for Claude Code — search chats/tickets/coupons, orders, late orders, agent activity, AI usage, release status. Register: `claude mcp add crm-prod --scope user -- node <repo>/tools/crm-mcp/dist/index.js` |
| **Scripts** (`scripts/`)                                                   | Release checks, schema/backfill, seeds (test vendor, quick replies), repairs (dry-run by default, `--write` to apply), portal promotion check, permission drift check                                                                         |
| **Docs**                                                                   | `docs/MULTI-VENDOR.md`, `docs/VENDOR-SECRETS.md`, `docs/DEPLOYMENT.md`, `docs/AWS-RESOURCES.md`, `docs/ai/ai-cost-estimate.xlsx` (`docs/RELEASE.md` describes an older Docker/GHCR flow except its schema rule)                               |

---

## 19. Known issues (found while writing this guide)

| #   | Issue                                                                                         | Effect                                                           |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `customer:presence` is never emitted by the server                                            | The "customer online" indicator in the agent portal never lights |
| 2   | **Branch notifications are queued but never sent** (no POS integration yet)                   | `store_notifications` stay `queued`                              |
| 3   | **Ticket import doesn't require a branch** (form does)                                        | Imported tickets may have no branch                              |
| 4   | Late-order coupons put the brand **name** into `brand_id`                                     | Harmless today (push uses the order's numeric brand)             |
| 5   | `/walk-in/link` saves `created_by: null`                                                      | No record of who minted a personal link                          |
| 6   | Late-orders query uses `DeliveryTypeIds=1` for delivery while the order map says 0 = delivery | Worth confirming with Yiji's data                                |
| 7   | Stale code comments (`AddCompensationCoupon`, `orderMaximum 100000`, `entry_point` default)   | Documentation only                                               |
| 8   | `docs/RELEASE.md` describes the old deploy flow                                               | Use this guide / `deploy-ecs.yml`                                |

---

## 20. Glossary

**Session** — one stretch of a conversation; a solved chat reopened by the customer starts a new session (new SLA clock, new welcome). **Route 1a/1b/2/3** — the four coupon delivery paths (§9). **Withheld** — approved coupon created on Yiji but not given to the customer. **Parked** — a portal build uploaded but not live until **Update now**. **Backfill** — a one-off script filling a new field on existing rows. **Connector** — the per-platform adapter that translates a vendor's API into the CRM's standard format. **Release checks** — automated checks run against an environment after every deploy.
