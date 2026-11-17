# Yiji v2 as a second tenant of the CRM

Implemented 2026-11-16 from the brief `Yiji V2/docs/integrations/crm/yiji-v2-second-tenant.md`
(owner decisions 0023/0024). State: **wired and tested, NOT activated**. Nothing here serves a
request until the owner creates the v2 vendor row and sets it to `active` (staging first).

Companion documents: `docs/YIJI-V2-INTEGRATION.md` (what the CRM needs from v2),
`docs/MULTI-VENDOR.md` (how a platform is onboarded), `docs/VENDOR-SECRETS.md`.

## 1. What exists in the code

| Piece                                 | Where                                                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform `yiji2`                      | `packages/shared-types/src/connector.ts`                                                                  | `CommercePlatform` / `COMMERCE_PLATFORMS`; the registry factory; `asCouponPushConnector` accepts it. `defaultVendorForLegacyRecords` stays v1-only: a record with no vendor is never v2's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Yiji2Connector`                      | `packages/shared-types/src/yiji2-connector.ts`                                                            | The `VendorConnector` for v2: partner API under `<api_base_url>/partner/v1`, client-credentials token (15 min, refreshed), bearer, `Idempotency-Key` on writes, 429 → unavailable with Retry-After (retried); a 4xx `{ error: { code, message_key, trace_id } }` → typed refusal, handed to the v1 processor as the refusal it records and never retries (v2, 2026-11-16: invalid input is HTTP **400 `VALIDATION_FAILED`**, no field list). Money `{ amount_minor, currency }` → major units (SAR 2 decimals, BHD 3). Ids int64 as number or string → strings. `order_number` = YYMM×10⁹+sequence.                                                                                                                                                                                    |
| Translating admin poster              | same file, `translateV1AdminCall`                                                                         | The workers' coupon and push processors keep sending **v1 paths and bodies**; the v2 connector maps them: `AddCoupon` → `POST /compensation-coupons`; `CreateCouponUserFromOrder` → coupon + `POST /grants`; `AddUserCoupon` / `AddCouponToUserByCode` → `POST /grants`; `RemoveUserCoupon/{id}` → `DELETE /grants/{id}`; `UpdateCoupon` → `PUT /coupons/{id}`; `UpdateStatusCoupon` → `PUT /coupons/{id}/status`; `SendCrmNotification` → `POST /customers/{id}/push` (by id, else by phone lookup); `AddCompensationCoupon` → refused (not provided on v2). Answers come back in v1's shapes (`result: 1`, coupon id in `exceptionMessage`, grant id in `extendedProperties.CouponUserId`), so every v1 safeguard (idempotency key, read-back on refusal, Private check) still runs. |
| Mock transport                        | same file, `MockYiji2Transport`                                                                           | Answers the partner routes from memory with v2-shaped data (customers `2000000001..3`, SA and BH, orders `2611000000001..3`), records every write. **Zero network.** Used by the tests, and by a vendor whose settings say `mock: true` — set only where `ALLOW_MOCK_VENDORS=true` (never production) and the record has no `api_base_url`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Settings                              | `RecordVendorSettingsSource.mergeYiji2`                                                                   | From the v2 row only: `api_base_url`, `tenant_id`, `brand_id`, `notify_settings`; credentials from `VENDOR_<KEY>_CLIENT_ID` / `VENDOR_<KEY>_CLIENT_SECRET` (`vendor-secrets.ts`). Never a `YIJI_*` value. Without credentials the connector's capabilities are `null` and reads answer empty (one warning), so nothing is sent anywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Coupon endpoint                       | `services/workers/src/processors/coupon-push.ts`                                                          | `couponEndpointFor(vendorId, platform)`: `yiji2` is chosen by the platform (its tenant id is not `1`). The v1 endpoint table is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Coupon removal / edit guard           | `services/workers/src/processors/index.ts`                                                                | The removal and edit processors still talk to Yiji **v1** through the workers' own client. A coupon whose vendor row is on another platform is refused there (logged, left as is) — never sent to v1. See open items.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Late orders                           | `services/workers/src/processors/late-orders-poll.ts`, `packages/shared-types/src/order-events.ts`        | **No poller for v2.** The board is the CRM's own live table (`late-orders:live:yiji2:<id>`) fed by events; `getLateDeliveryOrders` on the v2 connector answers nothing. `orderEventFromYiji2` turns the v2 envelope into the CRM's event (`order.late` → open delivery order at `placed_at`, derived from `elapsed_seconds` if absent; `order.status_changed` → close).                                                                                                                                                                                                                                                                                                                                                                                                                |
| Inbound API for v2                    | `services/socket-gateway/src/index.ts`, `yiji-inbound.ts`                                                 | A second mount of the same API at `/webhooks/yiji2/tickets`, `/tickets/{externalId}`, `/compensation-rules`, `/events`, verified with `VENDOR_YIJI2_WEBHOOK_SECRET` (503 until set; 401 for v1's secret), writing under the v2 vendor (`YIJI2_VENDOR_ID`, active only → 503 while inactive). Events in v2's envelope, de-duplicated under `yiji2-events:seen:<id>` (7 days), queued with vendor key `yiji2:<id>`. The bare `POST /webhooks/yiji2` (MV-3) also works, with the same secret.                                                                                                                                                                                                                                                                                             |
| Chat login                            | `services/socket-gateway/src/auth/customer-jwt.ts` (unchanged)                                            | A v2 customer token names `vendor_id: "2"` and is verified with `VENDOR_YIJI2_JWT_SECRET`. One signed by v2 that names no vendor is refused — the default vendor (`1`) never swallows it. `POST /chat/session` takes `vendorId: "2"` (`docs/VENDOR-INTEGRATION.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Cache keys                            | `services/ai-gateway/src/commerce/index.ts`                                                               | Every commerce cache key carries `<platform>:<vendor id>` for a non-v1 vendor; v1's keys are byte-for-byte what they were.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Settings per platform                 | `packages/shared-types/src/late-delivery.ts`, `services/ai-gateway/src/directus/index.ts`                 | `app_settings` has no vendor column: v2's threshold lives under **`late_delivery_minutes_yiji2`** (`lateDeliveryMinutesKeyFor`). v1's `late_delivery_minutes` is untouched. A missing v2 row = the default 60, never v1's number. The gateway reads it for the vendor each late-orders request names.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tenant selector                       | agent portal tickets, late orders, coupons, **contacts** (new); admin reports (`report-vendor.tsx`)       | One vendor or all, default all. Offered when **2+ vendors are active** (the MV-4 rule, unchanged and pinned by tests), so with v2 inactive the lists show v1 only and nothing visible changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Vendors page / schema / release check | `VendorsPage.tsx`, `directus/bootstrap/src/collections.ts`, `scripts/release-check/lib/vendor-checks.mjs` | `yiji2` offered and known. The release check visits active vendors only, so an inactive v2 row is not probed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Seed script                           | `scripts/seed-yiji2-vendor.mjs` (+ `scripts/lib/yiji2-vendor-seed-plan.mjs`)                              | Creates the row **inactive**, idempotently; never activates, never deletes, never touches v1, refuses production without `--allow-prod`. Dry run by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 2. The vendor row (owner to confirm the id and key — brief §7.2)

| Field                        | Value                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `name`                       | Yiji V2                                                                                   |
| `platform`                   | `yiji2`                                                                                   |
| `yiji_vendor_id`             | `2`                                                                                       |
| `webhook_path_key`           | `yiji2`                                                                                   |
| `api_base_url`               | `https://api.staging.yiji.app` (placeholder; prod `https://api.yiji.app` when registered) |
| `admin_api_url`, `tenant_id` | empty                                                                                     |
| `status`                     | **inactive**                                                                              |

Create it with `API=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/seed-yiji2-vendor.mjs` (dry run),
then `--write`. Or by hand on the Vendors page.

## 3. Secrets and env (names only; values live in the task definitions)

| Service                            | Variable                                               | Purpose                             |
| ---------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| socket-gateway                     | `VENDOR_YIJI2_JWT_SECRET` (≥ 32 chars)                 | v2 customer chat tokens             |
| socket-gateway                     | `VENDOR_YIJI2_WEBHOOK_SECRET`                          | `/webhooks/yiji2/*` signatures      |
| socket-gateway                     | `YIJI2_VENDOR_ID`                                      | the row's platform id (default `2`) |
| ai-gateway, workers                | `VENDOR_YIJI2_CLIENT_ID`, `VENDOR_YIJI2_CLIENT_SECRET` | partner API client credentials      |
| ai-gateway, workers (staging only) | `ALLOW_MOCK_VENDORS=true` + an empty `api_base_url`    | the in-memory v2 transport          |

Nothing of v1's is reused: a v2 vendor without its own variable has no credential.

## 4. Activation (the owner's steps, in order)

1. **Staging.** Create the row (inactive). Add the four `VENDOR_YIJI2_*` variables to the staging
   task definitions (AWS change: owner approval). Give v2 staging the webhook secret and the chat
   secret. Set `api_base_url` to v2's staging host. Set `status = active` on the Vendors page.
2. **Check on staging.** `GET /commerce/order?vendorId=2&orderId=<a v2 order>` answers from v2;
   a signed `POST /webhooks/yiji2/events` with an `order.late` puts the order on the late-orders
   board under the v2 tenant; a v2 ticket through `POST /webhooks/yiji2/tickets` lands under the
   v2 vendor; a coupon approved for it is delivered as a v2 coupon + grant.
3. **Production**, on the owner's word only: same row, same variables, activate.

While the row is inactive: the registry answers `unknown_vendor` (404) for it, the inbound API
answers 503, the poller ignores it, the tenant selector stays hidden, and no coupon is sent.

## 5. Open items (not in this change)

1. **Coupon removal and edit for v2.** The removal/edit processors use the workers' own v1
   client; for a v2 coupon they refuse and log (`coupon change for a non-v1 platform`). The
   connector already translates `RemoveUserCoupon` → `DELETE /grants/{id}` and `UpdateCoupon` →
   `PUT /coupons/{id}`; wiring those processors through the row's connector is the next step.
2. **Historical late-orders register for v2** (a date range). Since 2026-11-16 v2 offers
   `GET /orders/export` (closed orders created in a range of at most 92 days, up to 5,000 rows
   with items, money breakdown and `closed_at`) and `GET /orders/changed?since=` (one row per
   status change, at most 92 days back); the register can be built on them. Order states are
   v2's 15 (contract 17 Nov): `delivered`, `handed_over`, `closed`, `cancelled` close an order;
   `arrived` is still in delivery; `finding_courier` / `courier_assigned` are "ready". v2 has no `GetFilteredOrders`;
   `GET /orders/changed?since=` is reconciliation only and not wired. Today's live board works
   from events; a past range answers empty for v2.
3. **The `POST /compensation-coupons` body** follows the draft's `CompensationCouponCreate`
   (agreed with the v2 session 2026-11-16): `code` (also the idempotency key), `title {ar, en}`,
   `type` amount|percent, `category` general|private, `valid_from`, `valid_to`, `usage_limit`,
   `total_discount_limit` (Money), `reason`, `brand_id`, `country` SA|BH; optional `customer_id`
   or `phone`, `order_number`, `restaurant_id`, `value` (Money) or `percent_bps` + `max`. The
   answer (`CompensationCouponResult`) carries `grant_id` when a customer or order was named, so
   the grant is one call. Rules confirmed 17 Nov (amount only, total >= value x uses, country
   currency, brand/restaurant): see "Partner contract of 17 Nov 2026" below.
4. **Money for display is converted** (`yiji2Amount`); the marketing contract stays SAR-only
   (brief §7.1).
5. **"All tenants" view linking one person across vendors by phone** (brief §7.3): the lists show
   each vendor's rows side by side; no linked-person view yet.
6. **Reports** filter by vendor already (MV-4); per-platform settings beyond the late threshold
   (none are read per vendor today) are added when a second one appears.
7. **Currency is SAR unless told otherwise.** The connector never guesses it from the vendor's
   name (review 2026-11-16). A Bahrain vendor needs an explicit `currency` (`Yiji2PlatformSettings.currency`),
   which means a `vendors.currency` column + read grant before such a vendor is activated.
8. **A 404 on a WRITE is a settled refusal** with code `not_found` (contract 17 Nov; a
   `POST /compensation-coupons` on a wrong `api_base_url` parks the coupon rather than retrying). v1 behaves the
   same; set the host right before activating, and watch the first coupon.
9. **Event payload (confirmed by the v2 session 2026-11-16, `crm-events-v1.yaml`):** every
   `order.*` event carries `order_number`, `customer_id`, `at`, `restaurant_id`, `brand_id`,
   `country`, `is_group_master`, `order_type` (delivery | pickup | carhop | dine_in | takeaway |
   food_court_parent | food_court_sub | catering) and `state`; `order.late` adds
   `elapsed_seconds` + `threshold_minutes`; the total is `data.total` `{amount_minor, currency}`.
   The mapper treats a missing `order_type`, `state` or `order_number` as MALFORMED (ignored and
   logged, never defaulted). A food-court parent is the delivered, grouped order; a sub is hidden
   behind its parent; takeaway → takeout; catering → other (off the delivery board). The exact
   payloads are re-checked when v2's events code is merged.

### Partner contract of 17 Nov 2026 (v2 partner routes merged)

The v2 team merged their partner routes and gave the contract below; every point is applied in
`packages/shared-types/src/yiji2-connector.ts` (+ `order-events.ts` for states) and pinned by tests
(`packages/shared-types/tests/yiji2-connector.test.ts`, "contract 2026-11-17";
`services/workers/tests/coupon-push-yiji2.test.ts`, the real v1 processors against the mock).
v1 is untouched.

1. **Events.** Receiver `/webhooks/yiji2/events`; HMAC-SHA256 over `<unix seconds>.<raw body>` in
   `X-Yiji-Timestamp` / `X-Yiji-Signature` - the code already matched (`webhook.ts`, the same
   verifier as v1, `sha256=` prefix optional). `order.*` states are exactly the platform's 15
   (`YIJI2_ORDER_STATES`): created, awaiting_payment, accepted, sent_to_kitchen, kitchen_confirmed,
   preparing, ready, finding_courier, courier_assigned, out_for_delivery, delivered, arrived,
   handed_over, closed, cancelled. **Closing set = delivered, handed_over, closed, cancelled**
   (`YIJI2_CLOSING_STATES`), shared by the connector and the events mapper. Changed: the older
   draft words (`refunded`, `completed`, `canceled`, `placed`, `paid`, `pending_payment`,
   `delivering`) are no longer mapped and no longer close an order; an `is_open` on the payload
   still wins. `arrived` stays open (in delivery).
2. **`POST /compensation-coupons`.** Checked LOCALLY before any call (`v2CouponProblem`), each a
   400 refusal handed to the v1 processor as the refusal it records on the row and never retries:
   - `percent_not_supported_on_v2` (field category): v2 creates AMOUNT coupons only.
   - `total_limit_below_uses_on_v2` / `total_limit_missing_on_v2`: v2 needs
     `total_discount_limit >= value x usage_limit`. **Choice: refuse, never raise.** The CRM's
     total (`reachLimit` = the agent's / approver's "Total given discount limit") is the most the
     coupon may ever give; raising it would send a coupon more generous than the CRM approved. The
     reason names the numbers; an admin re-approves with a total covering every use. (A Private
     row's calculated total = uses x max discount already satisfies the rule.)
   - `currency_not_country_on_v2`: every money pair in the vendor country's currency (SA -> SAR,
     BH -> BHD).
   - Brand / restaurant: v2 owns that data, so it is NOT pre-checked; v2's 400 (field `brand_id` /
     `restaurant_id`) is recorded the same way. Note: the CRM row stores a brand NAME, so no
     `brand_id` is sent today; v2 derives the brand from `restaurant_id` in the mock - **confirm
     with v2** whether `brand_id` is required when `restaurant_id` is given.
   - At or above SAR 200 / BHD 20: created; v2 only alerts (mock: `alerts`). Nothing caps it here.
   - `UpdateCoupon` (`PUT /coupons/{id}`) is checked only on the fields it names.
     The mock enforces the same rules (400 `VALIDATION_FAILED` with `field`), so tests mirror v2.
3. **Grants.** `DELETE /grants/{id}` and `POST /grants` work only on coupons the CRM created through
   the partner API; others answer 404. Re-granting a removed grant answers 409 `COUPON_INVALID`.
   Changed: the transports now answer `null` for a 404 on a READ only; a 404 on a WRITE
   (POST/PUT/DELETE) is a refusal with code `not_found` - `RemoveUserCoupon` of a grant that is
   not the CRM's is a recorded refusal, never a silent success. 409 `COUPON_INVALID` is a recorded
   refusal. `Yiji2RefusedError` carries v2's `field`; the recorded reason reads
   `CODE [field]: message (trace …)`. Mock: an app-created coupon + grant (`V2-APP-WELCOME`,
   grant 600001) is readable but answers 404 to writes.
4. **`POST /customers/{id}/push`** answers 202 `delivered` (+ `notification_id`) or `no_device`;
   data keys `topic` and `action` are refused. The v1 CRM payload carries the tap action as
   `data.prop1` (`crm.openchat`, from `openChatAction`) - not refused, kept. Changed: the
   translator no longer sends a top-level `action`; `data.topic` is dropped (`notifyTopic` belongs
   to v1's template endpoint, which v2 does not map) and `data.action` is renamed to `prop1`
   (`v2PushData`). `delivered` -> v1 success (`NotificationId` in `extendedProperties`);
   `no_device` -> v1's own words "Customer has no registered FCM device token.", which the v1 push
   processor records as `push_unreachable` and never retries - exactly as for a v1 customer with
   no FCM token. An unknown customer answers "Customer not found" (also settled, not retried).
   Mock: customer `2000000003` has no device; topic/action keys -> 400.
5. **`GET /grants`** (by customer or ids, newest first, paged by `after_id`): `findCustomerCoupon`
   pages through it (`findGrantByCode`: 100 a page, follows `next_after_id` or the last id of a
   full page, at most 50 pages, stops on a cursor that does not move). Where `/grants` answers 404
   (older v2) the customer's embedded `coupons` are read.

### Review 2026-11-16 (independent cloud review, fixed in commit after 915af581)

- v1's coupon reader / group-order reader are handed only to v1 jobs (a v2 coupon id read on v1
  parked the coupon on a stranger's coupon type); the hourly misuse check skips v2 rows.
- Removal/edit guard fails CLOSED: an unreadable vendor platform throws (retried), never falls
  through to v1's admin API.
- The v2 late-orders board is rebuilt from the live table on every poll, not only inside the
  15-minute events mode (an order late at 10:00 is still late at 10:20 with no new event).
- A refused or empty token answer is an outage (retried), never a parked coupon.
- Coupon dates go to v2 as RFC 3339 with the fixed `+03:00` offset (SA and BH).
- A failed integration read never gives an active v2 vendor the in-memory mock (staging).
- The seed script corrects only `platform` + `webhook_path_key`; the owner's host/name/colours
  are never reset; an empty host gets the placeholder.
- Attach-by-code is matched as v1 sends it (ids in the path).
- `Yiji2UnavailableError` is an outage to the v1 helpers too (`isYijiUnavailable`).

## 6. Tests

`packages/shared-types/tests/yiji2-connector.test.ts` (mapping, money, ids, translator, HTTP
transport, registry, settings, events, setting key, zero network),
`packages/shared-types/tests/yiji2-vendor-seed.test.ts`,
`services/workers/tests/coupon-push-yiji2.test.ts` (the real processor delivers a v2 coupon
into the mock; an inactive vendor gets nothing), `services/socket-gateway/tests/yiji2-inbound.test.ts`
(signature with v2's secret, de-dup, batch, v1/v2 isolation, chat token),
`services/ai-gateway/tests/commerce-yiji2.test.ts` (connector, cache keys, per-platform threshold,
inactive = 404), `apps/admin-portal/tests/vendors-page-yiji2.test.tsx`,
`apps/agent-portal/tests/contacts-vendor-filter.test.tsx`.
