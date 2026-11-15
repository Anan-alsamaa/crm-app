# The promotion engine contract: what Yiji v2 provides to the CRM's marketing portal

For the Yiji v2 team. Written 2026-11-15 from the CRM's marketing portal, which is built and
running on sample data to this exact interface; going live is a configuration change once v2
answers these calls. The source of truth is `packages/shared-types/src/marketing-engine.ts`
(TypeScript types and zod schemas) - this page is the readable version.

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
default, so shipping it changes nothing for anyone):

1. **Services release** (from `release/svc-1.2.48`): the Directus `app-roles-sync` marketing
   grants, the AI gateway `/commerce/marketing/*` routes (points + engine proxy), the workers
   marketing sender (behind `MARKETING_COUPON_SEND`, default off).
2. **Schema**: `pnpm --filter @yiji/directus-bootstrap run apply:fields` against production
   BEFORE the services images (collections `marketing_coupons`, `marketing_campaigns`,
   `marketing_coupon_recipients`, `marketing_activity`). Fields-only; never a full `apply`.
3. **Portals release** (from `release/portals-1.2.49`): the marketing portal itself, and the
   admin Roles page offering `use_marketing_portal` / `manage_marketing` / `approve_marketing`
   (today its `NOT_OFFERED` list hides them on production).
4. The Administrator grants the three switches to the marketing roles.

Then the four "Going live" steps above (two gateway variables, the `marketing_engine` setting).
