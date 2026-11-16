# The marketing engine contract: what the CRM's marketing portal is served

**2026-11-16 (owner): the CRM owns its marketing backend.** Yiji v2 implements nothing for the
marketing portal; Yiji (v1 today, v2 later) is only the commerce platform - customers, orders,
coupons, grants, push - reached through the vendor connectors and the workers. The engine below
is answered by the CRM's own AI gateway (`services/ai-gateway/src/marketing/crm-engine.ts`,
routes in `engine-routes.ts`), stored in Directus. The source of truth for the shapes is still
`packages/shared-types/src/marketing-engine.ts`; this page is the readable version. The text
further down, written 2026-11-15 when v2 was expected to implement it, is kept for the paths
and shapes, which did not change.

## How it is served (2026-11-16)

- `/commerce/marketing/engine/<path>` on the AI gateway, the same paths `live.ts` calls. No
  `/v1` hop, no external host. `MARKETING_ENGINE_URL` + `MARKETING_ENGINE_KEY`, if both are
  ever set, put the old proxy (`engine.ts`) back instead - an override, off by default.
- **Who:** the caller's own Directus session (`/users/me`) and their `app_roles` row
  (`effectivePrivileges`). `use_marketing_portal` opens the door; `manage_marketing` prepares
  (campaigns, submission, status, issuance, studies, gift card products, earning rules);
  `approve_marketing` decides; the `Administrator` role holds all three.
- **Storage:** written only by `svc-ai-gateway` after the rules: `marketing_campaigns` (typed
  columns + the whole validated draft in `draft`), `marketing_studies`,
  `marketing_gift_card_products`, `marketing_earning_rules`, `marketing_activity`. People read
  them; nobody writes them directly.
- **Rules enforced on the server:** four eyes (the creator never decides their own campaign or
  study, the Administrator included); the approval reasons (`cost_above_threshold`,
  `deep_discount`, `forecast_loss`) recomputed from the draft and the money model
  (`app_settings.marketing_money_model` over `DEFAULT_MONEY_MODEL`) at submission and at the
  decision; `LOCKED_WHEN_LIVE` for live, paused and ended campaigns; no edits while waiting for
  approval; editing an approved campaign withdraws the approval; status moves only
  `approved -> live <-> paused -> ended`.
- **Issuance** (`POST /issuance`) goes through the EXISTING coupon pipeline: one
  `marketing_coupons` list coupon per batch, its customers as `marketing_coupon_recipients`,
  marked approved (by the campaign's approver) after the list is written; the workers'
  marketing sender (`MARKETING_COUPON_SEND=on`) creates it on Yiji and hands it out. Customer
  ids are Saudi mobiles, or Yiji customer ids the CRM knows from `contacts`. The control group
  is held back; customers who already hold it, or past the total-redemptions / budget ceiling,
  are skipped with the reason. **A campaign whose rules a v1 coupon cannot carry is refused
  with the fields named** (`422 not_issuable`), never issued wider than approved: offer types
  other than FIXED / capped PERCENT, partial redemption, A/B experiment, stamp cards, a maximum
  order, previous-orders / first-order rules, a subset of payment methods, more than one brand,
  branches / categories / products, daily limits, times of day, days of the week, an
  unlimited-per-customer mode without a number, an expired end date, a SHARED code not in the
  `MKT-` form.
- **No data source yet, answered empty or zero in the sample's shapes:** redemptions,
  performance revenue / discount / ROI / control-group lift, gift card sales, stats and
  activity, points (rewards campaigns, items, stats, members), the orders export, opportunities
  and customer groups, the catalogue's categories and products (brands are the coupon brands,
  branches the CRM stores). Performance's `issued` and `perDay` are real: what the sender gave.

## Going live (2026-11-16)

1. Schema: `pnpm --filter @yiji/directus-bootstrap run apply:fields -- --only=marketing_campaigns,marketing_studies,marketing_gift_card_products,marketing_earning_rules`
   (plus the four marketing collections where they are still missing).
2. Grants: the `svc-ai-gateway` rows from `roles.ts`; the portal roles' rows come from the
   `app-roles-sync` extension when Directus restarts with it.
3. Deploy the services (gateway) and the Directus extension.
4. The Administrator sets `marketing_engine` = `live`. The sample engine stays for local
   development and tests.

---

## How the CRM calls you

- Base URL: yours, per environment (staging + production). The CRM's gateway forwards
  `/commerce/marketing/engine/<path>` to `<MARKETING_ENGINE_URL>/v1/<path>` with
  `Authorization: Bearer <MARKETING_ENGINE_KEY>` (a service key for the CRM, per environment).
- JSON in, JSON out. Answer `{ "data": ... }` or a bare value; the gateway normalises.
- Errors: `4xx` with `{ "error": "<code>", "message": "<for a person>" }`; never a `200` for a
  refusal.
- Every monetary value in SAR, every timestamp ISO 8601 with offset or `Z`.
- Ids are strings. `campaignId`, `studyId`, `customerId`, `productId`, `branchId` are yours.

## 1. Home and reference data

| Call                  | Returns                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/home`        | `HomeSummary`: coupons (live, redeemed, discountSar, waitingApproval), studies, performance (extraSalesSar, roiPct, campaignsMeasured, alerts), giftCards, rewards, `alerts[]` (id, area, title, body, severity). |
| `GET /v1/catalogue`   | `{ brands[], branches[], categories[], products[] }` with ids, names, prices, order types.                                                                                                                        |
| `GET /v1/money-model` | Finance's cost model (`MoneyModel`): food %, packaging %, channel cost % per order type, would-order-anyway %, message cost per channel, approvalAboveSar, deepDiscountPct, version.                              |

## 2. Campaigns (the seven-step form)

A campaign is `CampaignDraft` + status + audit. The field set is the portal's "Field
specification" page (`CAMPAIGN_FIELD_SPEC`, 84 fields in 7 steps):

- `objective` (16 goals), `name {en, ar}`, `reasonCode`, `funding {source, partnerSharePct}`, `tenantId`, `notes`
- `offer`: `type` PERCENT | FIXED | BXGY | FREE_ITEM | BUNDLE | FREE_DELIVERY | CASHBACK, with `percent`, `amountSar`, `maxDiscountSar`, `bxgy {buyQty, getQty, productIds}`, `freeItem {productId, quantity}`, `bundle {productIds, priceSar}`, `deliveryFeeCovered` (FULL | SAR), `cashback {creditValidityDays}`, `posDiscountCode`, `onRefund`, `onCancelBeforeCompletion`, `partialRedemption {enabled, maxPerOrderSar, balanceExpiry, onOrderCancel}`
- `experiment {enabled, variantB.value, splitPctA, winnerMetric, autoWinnerAfterDays}`
- `trigger.birthday {occasion, issueDaysBefore, missingDateOfBirth, tierBoost}`
- `loyalty {stampsRequired, reward, stampExpiryDays, milestones, minOrderToCountSar, countOrdersFrom, repeat, progressMessages}`
- `audience {mode SEGMENT|LIST|PHONES|ALL, conditions[{c,p}], match, phoneNumbers[], listId, visibility, controlGroupPct, excludeDiscountSensitive}`
- `rules {minOrderSar, maxOrderSar, previousOrders, firstOrderOnly, paymentMethods[]}`
- `scope {brandIds[], branchIds[], categoryIds[], productIds[], excludedProductIds[], orderTypes[]}`
- `limits {perCustomerMode, perCustomerMax, totalRedemptions, dailyRedemptions, budgetSar}`
- `distribution {codeType NONE|SHARED|UNIQUE, code, uniqueCodeCount, channels[]}`
- `stacking {combineWithOtherOffers, combineWithLoyalty, combineWithOtherCoupons}`
- `validity {startDate, endDate, startTime, endTime, daysOfWeek[]}`

Status: `draft → finance_review → waiting_approval → approved → live → paused → ended`, or
`rejected`. **Rules the engine enforces:** the creator never approves (`createdBy !==
decidedBy`); once `live`, `offer`, `audience`, `distribution.code`, `rules` and
`validity.startDate` cannot change (`LOCKED_WHEN_LIVE`); the campaign pauses itself at
`limits.budgetSar` or `limits.totalRedemptions`.

| Call                                            | Body / returns                                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------- |
| `GET /v1/campaigns?status=&objective=`          | `Campaign[]`                                                                                                                                                                                       |
| `GET /v1/campaigns/{id}`                        | `Campaign` or 404                                                                                                                                                                                  |
| `POST /v1/campaigns` · `PUT /v1/campaigns/{id}` | `CampaignDraft` → `Campaign` (422 names the invalid field)                                                                                                                                         |
| `POST /v1/campaigns/{id}/submit`                | `{ forecast }` → status `waiting_approval`, `snapshot` = forecast (immutable)                                                                                                                      |
| `POST /v1/campaigns/{id}/decision`              | `{ decision: approve                                                                                                                                                                               | reject, note }`→`approved`/`rejected`; 403 for the creator |
| `POST /v1/campaigns/{id}/status`                | `{ status: live                                                                                                                                                                                    | paused                                                     | ended }` |
| `POST /v1/issuance`                             | `{ campaignId, customerIds[] }` → `{ batchId, requested, issued, skipped[{customerId, reason}] }` (paced on your side)                                                                             |
| `GET /v1/campaigns/{id}/performance`            | `CampaignPerformance`: issued, redeemed, revenueSar, discountSar, extraOrders, extraProfitSar, roiPct, `controlGroup {size, orderRatePct, exposedOrderRatePct}`, `perDay[]`, `plan` (the snapshot) |
| `GET /v1/campaigns/{id}/redemptions?limit=`     | `Redemption[]` (id, customerId, orderId, branchId, amountSar, at, reversed)                                                                                                                        |
| `POST /v1/checkout/simulate`                    | `{ campaignId, brandId, orderType, subtotalSar, otherOffer, otherCoupon, loyalty }` → `{ allowed, discountSar, message, appliedOrder[], reason? }` - the SAME rules checkout applies               |

## 3. Liability, gift cards, rewards

| Call                                                                     | Returns                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/liability`                                                      | `{ asOf, byProduct[{product, faceValueSar, atCostSar, count}], totalFaceValueSar }`                                                                                |
| `GET /v1/gift-cards/products` · `POST` · `PUT /{id}`                     | `GiftCardProduct` (name {en, ar}, valueSar, priceSar, validityDays, design, active, canCombineWithCoupons)                                                         |
| `GET /v1/gift-cards/stats?from=&to=`                                     | `GiftCardStats` (sold, salesSar, redeemedSar, redemptions, outstandingSar, activeCards, unusedCards, unusedSar, sentAsGift, boughtForSelf, perDay[], expiringSoon) |
| `GET /v1/gift-cards/activity?limit=`                                     | `GiftCardActivity[]` (sold / redeemed / expired / refunded)                                                                                                        |
| `GET /v1/rewards/earning-rules` · `POST` · `PUT /{id}`                   | `EarningRule` (cashbackPct per order type, brandIds, active, validFrom, validTo)                                                                                   |
| `GET /v1/rewards/campaigns` · `/items` · `/stats` · `/members?q=&limit=` | points campaigns, the marketplace, the six-month stats, members (tier, points, earned, redeemed, last order)                                                       |

## 4. Pre-studies

| Call                                          | Returns                                                                                                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/orders/export?from=&to=`             | `OrdersExportRow[]` (orderId, customerId, placedAt, brandId, branchId, city, orderType, totalSar, items[], couponCode, completed) - paged by date range; up to 5,000 rows per call |
| `GET /v1/studies` · `GET /{id}` · `PUT /{id}` | `Study` (scenarios with `CampaignDraft` + input + forecast, chosenScenarioId, review, approval, campaignId)                                                                        |
| `GET /v1/studies/opportunities?from=&to=`     | `Opportunity[]` per objective: customersMatched, expectedReturnPct, expectedNetSar, recommendedOfferText                                                                           |
| `GET /v1/studies/customer-groups?from=&to=`   | `CustomerGroup[]`: LOYAL, HIGH_VALUE, AT_RISK, LOST, NEW with counts and shares                                                                                                    |

## 5. Webhooks to the CRM (events)

`redemption.created`, `redemption.reversed`, `campaign.budget_reached`, `campaign.ended`,
`study.approved`, `liability.threshold` - signed and delivered like the order events in
`docs/yiji-inbound-api.md` ("POST /events").

## Going live

1. v2 answers the calls above on staging with a service key for the CRM.
2. The CRM gateway gets `MARKETING_ENGINE_URL` + `MARKETING_ENGINE_KEY` (staging first).
3. The Administrator sets the global setting `marketing_engine` = `live` in the CRM.
4. The portal's "Sample data" badge disappears; the numbers are Yiji's. No release needed.

## Production (the CRM side, prepared 2026-11-15)

The production site exists and the deploy ships to it on every portals release:

| Item                                   | Value                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Bucket                                 | `crm-prod-marketing-portal` (us-east-2, private, CloudFront only)                            |
| Distribution                           | `E346RTMV30EWF` = `https://d1ow5z55ugh88b.cloudfront.net`                                    |
| Hostname (DNS pending with Anan IT)    | `crm-marketing.anan.sa` CNAME -> `d1ow5z55ugh88b.cloudfront.net` (cert `*.anan.sa` in place) |
| Staging hostname (DNS pending as well) | `crm-marketing-staging.anan.sa` CNAME -> `d7f4ox67mxj6s.cloudfront.net`                      |
| CORS                                   | prod Directus rev 182 and AI gateway rev 179 name both prod origins                          |

What production still lacks until the next releases (everything below is OFF for every role by
default, so shipping it changes nothing for anyone). Both release branches were PREPARED and
passed the full gate on 2026-11-15 evening; they are tagged only on the owner's word:

1. **Schema first**: against production, BEFORE the services images (collections
   `marketing_coupons`, `marketing_campaigns`, `marketing_coupon_recipients`,
   `marketing_activity`; prod has none of them today, staging has all four). Fields-only;
   never a full `apply`:

   ```bash
   export DIRECTUS_INTERNAL_URL=https://crm-api.anan.sa DIRECTUS_ADMIN_EMAIL=... DIRECTUS_ADMIN_PASSWORD=...
   pnpm --filter @yiji/directus-bootstrap run apply:fields -- \n     --only=marketing_coupons,marketing_campaigns,marketing_coupon_recipients,marketing_activity
   ```

2. **Services release** `release/svc-1.2.51` = `release/svc-1.2.48` + the twelve marketing
   commits (cherry-picked; the only conflict, `scripts/check-permission-drift.mjs`, resolved to
   main's version): the Directus `app-roles-sync` marketing grants, the AI gateway
   `/commerce/marketing/*` routes (points + engine proxy), the workers marketing sender (behind
   `MARKETING_COUPON_SEND`, default off). Tag `v1.2.51` (v1.2.50 is the routing fix of 16 Nov).
3. **Portals release** `release/portals-1.2.52` = `release/portals-1.2.49` (which already held
   marketing parts 1-5a) + the promotions portal, the engine-choice fix, the deploy change (that
   branch never built or uploaded the marketing portal before) and the Roles page offering
   `use_marketing_portal` / `manage_marketing` / `approve_marketing` (`NOT_OFFERED` keeps only
   the compensation-rules editor). Tag `v1.2.52`; the agent portal parks for Update now as
   always, the admin and marketing portals go live at once.
4. The Administrator grants the three switches to the marketing roles.

Then the four "Going live" steps above (two gateway variables, the `marketing_engine` setting).
