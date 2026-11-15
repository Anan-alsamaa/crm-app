# Sara CRM <-> Yiji v2: what the CRM needs from the new Yiji

For the team (and the Claude Code session) building Yiji v2. Written 2026-11-15 from the
CRM's live integration with Yiji v1 - every item below is something the CRM does today or a
problem it hit in production. Read this before designing v2's customer, order, coupon and
notification APIs, so the CRM plugs in without a rewrite on either side.

The CRM repo: `D:\emad\Afcoapp\ProgramFile\claudeCode\crm-app`. Two contracts the CRM already
publishes (keep them exactly as they are, v2 only has to call them):

- `docs/VENDOR-INTEGRATION.md` - how the app opens a customer chat (`POST /chat/session`).
- `docs/yiji-inbound-api.md` - how Yiji creates complaint tickets (`POST /webhooks/yiji/tickets`,
  HMAC-SHA256 signed).

## 1. How the CRM will connect to v2

The CRM is multi-vendor: every commerce platform is a **connector** behind one standard
interface (`packages/shared-types/src/connector.ts`, `VendorConnector`), picked by
`vendors.platform`. Yiji v1 is one connector (`'yiji'`), a mock is another. Yiji v2 becomes a
third (`'yiji2'`), so **v1 and v2 can run side by side while customers migrate** and nothing in
the CRM's chats, tickets, coupons or reports changes. The CRM only needs v2's API to cover the
operations in section 3.

Three things the CRM needs from day one of v2's test environment:

1. **A staging/test Yiji v2** with its own data. v1 never had one: the CRM's staging had to
   redirect coupons and pushes to a test handset on _production_ Yiji, and SaraPOS tests could
   only be done on prod. Give the CRM a staging base URL + staging credentials + staging
   webhook secret, separate from prod.
2. **A service account for the CRM** (not a person's login) with a role whose rights are
   written down. On v1 the CRM's account turned out to be `agent 1`, 403 on several calls the
   CRM needed (list coupons, remove a grant), and the owner's personal token became the
   fallback. v2: one account, the rights the CRM needs (section 3), nothing more.
3. **An OpenAPI/Swagger document** that stays current. v1's spec (949 endpoints) was the only
   way to find `GetUserById`, `GetfilteredCustomers` and `AddCompensationCoupon` after the
   CRM had wrongly concluded they did not exist.

Auth style: a long-lived API key or client-credentials token with `Authorization: Bearer`.
v1's `POST /api/Account/login` with a user password is fine too, but document the token
lifetime; the CRM caches it.

## 2. Calls Yiji v2 makes INTO the CRM (already built, keep the contracts)

| What                         | Endpoint                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open the in-app support chat | `POST https://crm-api.anan.sa/chat/session`          | Opened from the **mobile app**. Body `{ phone, customerId, entryPoint: "app", vendorId }`. Preferred: v2's backend makes the call and asserts the customer id, then hands the returned 12-hour JWT to the app, which opens the chat page with it. (The app may instead forward its own session token as `yijiSessionToken`; the CRM then resolves it through v2's customer-by-id call.) |
| Create a complaint ticket    | `POST https://crm-api.anan.sa/webhooks/yiji/tickets` | HMAC-SHA256 over `"<timestamp>.<raw body>"`, headers `X-Yiji-Timestamp` / `X-Yiji-Signature`. Required: `customer.phone`, `orderNumber`, `restaurantId`, `complaintType`, `serviceType`, `description`, `occurredAt`.                                                                                                                                                                   |
| Read a ticket it created     | `GET /webhooks/yiji/tickets/{externalId}`            | Same signing.                                                                                                                                                                                                                                                                                                                                                                           |

Two decisions already taken by the owner that v2 must respect:

- **Yiji only creates tickets.** It never sends coupons to the CRM (`POST /tickets/{id}/coupons`
  answers 410). Compensation is decided by WeCare in the CRM.
- **Send the customer's v2 user id** (`customer.yijiCustomerId`) on every ticket and chat
  session. It is what lets an approved coupon reach the right wallet without a phone lookup.

## 3. Calls the CRM makes INTO Yiji (what v2 must offer)

Everything the CRM calls on v1 today, grouped. Names are v1's; v2 can rename, but each row
must exist. "Fix" = a v1 behaviour that cost us an incident or a workaround; please design it
out.

### 3a. Customers

| Need                                          | v1 today                                                              | v2 must provide / fix                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer by id                                | `GET /api/User/GetUserById/{id}`                                      | id, phone, name, email, **push token present yes/no**, addresses.                                                                                                |
| Customer by phone                             | `GET /api/User/GetfilteredCustomers?PhoneNumber=`                     | **Fix:** v1 is a SUBSTRING match and `05XXXXXXXX` returns nothing (only `9665…`/`+9665…`). v2: exact match, accept `05…`, `9665…`, `+9665…`, return at most one. |
| Resolve the app's session token to a customer | the app forwards its own JWT; CRM calls GetUserById on the `Id` claim | Keep (or let the backend call `/chat/session` with the id - preferred).                                                                                          |

### 3b. Orders

| Need                                                       | v1 today                                                                 | v2 must provide / fix                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A customer's orders (newest first)                         | `GET /api/Order/GetOrderByUser/{userId}`                                 | Paged. **Fix:** v1's list is a summary (no items, no restaurant) so the CRM re-reads every order; v2 list rows should carry restaurant, brand, status, totals, coupon used.                                                                                                                               |
| One order, full                                            | `GET /api/Order/GetOrderAsync/{id}`, `GET /api/Order/GetOrderCart/{id}`  | Items **with modifiers and item ids (SKU)**, restaurant id + brand id (not only names), delivery address, money breakdown, coupon/grant id used, payment status, tracking URL. **Fix:** v1's outer `total` is 0 on every row (the real one is nested); `foodPrice` vs `total` disagree. One honest total. |
| Order timeline                                             | `GET /api/OrderStatusHistories/GetOrderStatusHistoriesByOrderId/{id}`    | One row per status change. **Fix:** v1 stamps Riyadh local time with no zone (the CRM adds +3 by hand). v2: ISO 8601 with offset or UTC, everywhere. Dedupe repeated `arrived`.                                                                                                                           |
| Group / food-court orders                                  | `GET /api/Order/GetFoodCourtSubOrders/{masterId}`                        | A master with sub-orders per restaurant. **Fix:** v1 marks neither side clearly (`subFoodCourtOrders` empty, `isMainSubOrder` false everywhere). v2: `isGroupMaster`, `parentOrderId`, and never return a sub-order as a plain order in the customer's list without that flag.                            |
| Late orders queue (if it stays in the CRM - see section 5) | `GET /api/Order/GetFilteredOrders?WithTotalServicesTimeFilterActive=60…` | Elapsed-so-far filter on live orders. **Fix:** date-to is exclusive (today returns nothing); finished/cancelled orders come back too. Better: a webhook (section 4) and no polling at all.                                                                                                                |

### 3c. Coupons (compensation issued by WeCare)

The CRM is the ledger of compensation: every coupon has a ticket, an approver, a reason, a
branch and a brand, and a daily audit compares the CRM row with Yiji. v2 must let it do that
without the v1 workarounds.

| Need                         | v1 today                                                                                                                       | v2 must provide / fix                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------- |
| Create a coupon AND grant it | `POST /api/Coupon/AddCoupon` then `POST /api/CouponUser/AddUserCoupon` / `AddCompensationCoupon` / `CreateCouponUserFromOrder` | **One call**, idempotent on the CRM's coupon code: `{ code, title, customerId or phone, orderId (optional), brandId, restaurantId, type: private                                                                                                                                                             | general, category: amount | percentage, value, percent, maxDiscount, validFrom, validTo, usageLimit, totalDiscountLimit, reason, noOtherDiscounts, deliveryTypes }`. Returns the coupon id and the grant id. |
| Honest answers               | v1 answers **200 with `result: 2`** for a refusal and 400 for some others                                                      | 201 created / 409 already granted / 422 invalid with the field named / 429 with `Retry-After`. Never 200 for a refusal.                                                                                                                                                                                      |
| Never force type or category | a v1-era CRM path once forced every coupon to General (owner: "never again")                                                   | Take `type` and `category` as sent, echo them back, and never change them server-side.                                                                                                                                                                                                                       |
| Read a coupon / a grant      | `GET /api/Coupon/GetCoupon/id/{id}`, wallet `GET /api/CouponUser/GetCouponByUser/{userId}`                                     | **Fix:** v1's wallet lists only UNUSED coupons, so a redeemed coupon looks like a missing one; `GetAllUserCoupons` ignores its filter and returns all ~29k grants (38 MB). v2: grant by id with `status: active                                                                                              | used                      | expired                                                                                                                                                                          | removed | disabled`, `usedOnOrderId`, `usedAt`; filterable and paged lists. |
| Edit a coupon in place       | `PUT /api/Coupon/UpdateCoupon`                                                                                                 | **Fix:** on v1 any `UpdateCoupon` silently DROPS the coupon from the "Issued coupons" report. v2: an edit is an edit; reports stay complete; keep `lastModifiedBy` / `lastModifiedAt` so the audit can tell who changed what (v1 has no such field - a coupon switched off by hand could not be attributed). |
| Disable / remove             | `PUT /api/Coupon/UpdateStatusCoupon`, `DELETE /api/CouponUser/RemoveUserCoupon/{grantId}`                                      | Keep both; the CRM's account needs the right (on v1 it was 403).                                                                                                                                                                                                                                             |
| Issued-coupons report        | `GET /api/Report/IssuedCopouns` (token as a query param)                                                                       | A report that lists EVERY coupon in its validity window, including phone-granted ones (v1 showed ~75 of 501 CRM coupons).                                                                                                                                                                                    |
| Title / name convention      | v1's coupon `name` had to be the customer's `+9665…` number (console convention), the reason in `compensation`                 | v2: separate `title` (customer-facing), `recipient`, `reason`, `brandId`, `restaurantId`, `orderId` fields. Don't make the CRM encode meaning in a name.                                                                                                                                                     |

Rate limits: the CRM runs one global budget and a circuit breaker on 429 since the 2026-10-26
flood (3,800 calls in 25 min from a per-row lookup took every Yiji call down). v2: say the
limits (per key, per minute), answer 429 with `Retry-After`, and offer **batch** reads (customers
by ids, grants by ids) so the daily coupon audit is a handful of calls, not one per coupon.

### 3d. Push notifications

| Need                                                                     | v1 today                                                                         | v2                                                                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| Push to one customer (agent reply, coupon delivered, "open chat" action) | `POST /api/NotificationData/SendCrmNotification` / `SendNotification` by user id | Keep: `{ customerId, title, body, action: open_chat                                                                    | open_wallet | open_order, data }`. Return delivered / no-device, never silently drop. |
| Why a push failed                                                        | v1: `fcmToken` null on ~27% of accounts; the CRM can do nothing                  | Keep the device token on the account; expose `hasPushDevice` on the customer so the CRM can fall back to SMS/WhatsApp. |

### 3e. Promotion engine API (for the marketing portal hosted in the CRM - section 5)

The marketing portal (Ayman's "YIJI Promotions Portal" draft, 2026-11-15) will be built in the
CRM and launched together with v2. The split: **v2 runs the engine** (it validates every cart at
checkout, records redemptions, holds the ledger), **the CRM is the portal** (studies, campaign
set-up, approvals, performance, gift-card and rewards management). So v2 must expose the engine
as an API the CRM's portal drives; the CRM never re-implements checkout logic.

| Need                                   | v2 must provide                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Campaign / coupon CRUD, full field set | Create, read, update, pause, end a campaign with the fields in Ayman's spec (`campaign.*`, `offer.*` incl. PERCENT, FIXED, BXGY, FREE_ITEM, BUNDLE, FREE_DELIVERY, CASHBACK, `rules.*`, `scope.*`, `limits.*`, `distribution.*` incl. unique code batches, `stacking.*`, `trigger.*` e.g. birthday, `experiment.*` A/B, `loyalty.*` stamp cards). Locked fields once live (discount, customers, code, rules, start date) - v2 enforces, the CRM shows. |
| Issuance                               | Grant a campaign's coupon to a list of customer ids (one batch call, paced server-side), or make it visible to a segment; returns a batch id and per-customer outcome.                                                                                                                                                                                                                                                                                 |
| Catalogue                              | Read brands, branches, menu categories and items (ids + names + prices + order types) for campaign scope; items by id.                                                                                                                                                                                                                                                                                                                                 |
| Redemptions and performance            | Per campaign: issued, redeemed, revenue, discount given, per day, with control-group response; redemption list with order id, customer, amount, branch. Webhooks `redemption.created`, `campaign.budget_reached` (section 4).                                                                                                                                                                                                                          |
| Liability                              | Outstanding value by product (coupons, compensation, gift cards, points) at face value.                                                                                                                                                                                                                                                                                                                                                                |
| Gift cards                             | Products CRUD, sales and redemption list, balances; design assets are the CRM's.                                                                                                                                                                                                                                                                                                                                                                       |
| Rewards / points                       | Earning rules CRUD, customer balance, issued / redeemed / expired totals, marketplace items. (v1 only had reads: `GetUserLoyalityPoints`, `GetAllFixedPointsLoyality`, `GetAllPourcentagePointsLoyality`.)                                                                                                                                                                                                                                             |
| Order data for pre-studies             | A bulk, paged **orders export** (completed orders by date range: customer id, branch, brand, items, totals, order type, coupon used, timestamps) so the CRM can run Ayman's "find opportunities" studies without a CSV upload and without per-order calls.                                                                                                                                                                                             |
| Checkout validation                    | Stays inside v2 (`/v1/checkout/validate` in Ayman's draft). The CRM needs only a **simulator** call for the portal's "checkout test" (cart + coupon in, discount and message out), read-only.                                                                                                                                                                                                                                                          |

### 3f. Automatic compensation (owner, 2026-11-15: the rules go to v2)

Automatic compensation will NOT run in the CRM (decision 2026-11-14); v2 runs it. The CRM
hands v2 the rule model it already has (`compensation_rules`, admin-editable), so v2 implements
the same policy:

- **Match:** `complaint_type` (the ticket API's list), optional `service_type`, optional
  `min_delay_minutes`, optional `min_order_value` / `max_order_value`; `enabled`, `priority`;
  when several match, the most specific wins, then the highest priority.
- **Coupon to issue:** `coupon_type` (private|general), `discount_category` (amount|percentage),
  `coupon_value` or `coupon_percent` + `max_discount`, `usage_limit`, `valid_from` / `valid_to`
  (or a validity length), `total_discount_limit`.
- **Two ways to hold the rules.** Minimum: the CRM sends v2 this list and v2 keeps its own copy.
  Better, and preferred by the owner's "the CRM stays in control": v2 **reads the rules from the
  CRM** (`GET /webhooks/yiji/compensation-rules`, HMAC-signed, cached a few minutes) so operations
  edit them in the CRM's existing rules editor and v2 never needs a change.
- **Every automatic coupon is reported to the CRM:** v2 creates the ticket through the ticket
  API with `compensation: { ruleId, couponId, grantId, code, amount }` (or sends
  `coupon.granted` with the ticket's external id), so the CRM's compensation ledger, reports and
  daily audit stay complete. Approval is not required for a rule coupon issued by v2; the CRM
  records it as "auto (rule N)".

## 4. Webhooks the CRM needs FROM v2 (required - this is what ends the polling)

Signed like the CRM's own inbound API (HMAC-SHA256, timestamp, per-environment secret),
with an event id for idempotency and retries with back-off. Receiver:
`POST https://crm-api.anan.sa/webhooks/yiji/events` (the `/webhooks/yiji` prefix exists).

| Event                                                                                                                   | Payload                                                                                                                        | What the CRM does with it                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `order.created`, `order.status_changed`                                                                                 | orderId, customerId, status, at (ISO 8601 with offset), orderType, restaurantId, brandId, isGroupMaster, parentOrderId, totals | **Late orders without polling** (section 5): the CRM keeps its own live table of open orders and times each leg itself. |
| `coupon.granted`, `coupon.used`, `coupon.removed`, `coupon.status_changed`, `redemption.created`, `redemption.reversed` | couponId, grantId, code, campaignId, customerId, orderId, amount, status, by (user), at                                        | Compensation ledger and marketing performance stay in step with Yiji; the daily audit stops reading wallets one by one. |
| `campaign.budget_reached`, `campaign.ended`                                                                             | campaignId, spent, budget, at                                                                                                  | Portal alerts.                                                                                                          |
| `customer.updated`                                                                                                      | customerId, phone, name, hasPushDevice, dateOfBirth (if the customer gave it)                                                  | Keeps the contact in step (phone changes broke lookups on v1); birthday campaigns.                                      |

Plus one **reconciliation read** the CRM calls every few minutes as a safety net: open delivery
orders changed since `<timestamp>` (paged). If a webhook is lost, the board self-heals.

## 5. Ownership: what lives where (owner, 2026-11-15)

The owner's rule: **the CRM is the operations and marketing workspace and is owned by the
owner; Yiji v2 is the commerce platform and exposes data and engine APIs.** Work that people
do every day lives in the CRM so the CRM is used; v2 changes are kept to APIs and webhooks.

| Capability                          | Lives in                                                                                                    | v2's part                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-app support chat                 | CRM (widget + agent portal)                                                                                 | The mobile app opens it (section 2).                                                                                                                     |
| Complaint tickets                   | CRM                                                                                                         | Creates them through the ticket API (section 2).                                                                                                         |
| **Late orders**                     | **CRM**, rebuilt on v2's order webhooks: no minute-by-minute polling                                        | `order.*` webhooks + the reconciliation read (section 4). The CRM raises the ticket, notifies the branch (SaraPOS), compensates.                         |
| Compensation by WeCare              | CRM (request -> approval -> audit)                                                                          | Coupon create + grant API (3c), `coupon.*` webhooks.                                                                                                     |
| **Automatic compensation**          | **v2** (engine), rules from the CRM                                                                         | Section 3f; reports every automatic coupon back to the CRM.                                                                                              |
| **Marketing / promotions portal**   | **CRM** (Ayman's portal: studies, campaigns, approvals, performance, gift cards, rewards), launched with v2 | The promotion engine API (3e): campaigns, issuance, catalogue, redemptions, liability, orders export; checkout validation and the ledger stay inside v2. |
| Reports, SLAs, branch notifications | CRM                                                                                                         | -                                                                                                                                                        |

## 6. What to do first (for the v2 session)

1. Reply with v2's planned base URLs (staging + prod), auth style, and where the OpenAPI doc
   will live.
2. Keep calling the two CRM contracts in section 2 unchanged (chat session from the mobile app,
   ticket API). Add `customer.yijiCustomerId` on every ticket.
3. Draft the endpoints in section 3 (3a-3e) as OpenAPI, one line per "Fix" saying how v2
   handles it. The promotion engine API (3e) is the largest piece: confirm the campaign field
   set against Ayman's "Field specification" page (107 fields, 6 steps).
4. Draft the webhooks in section 4 (event names, payloads, signing) - the CRM will implement
   the receiver, the late-orders board on top of it, and a `yiji2` connector against the
   OpenAPI, and test on v2 staging first.
5. Implement automatic compensation (3f): say whether v2 will read the rules from the CRM
   (preferred) or hold a copy.
6. Create the CRM service account on v2 staging with the rights in section 3 and send the
   credentials to the owner out of band (never in chat or in a repo).
