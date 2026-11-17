# Every General coupon raises an alert (owner, 17 Nov 2026)

> "any general coupon created even on purpose should raise an alert."

A **General** coupon (Yiji type `0`) can be added to _any_ Yiji account by
whoever knows the code — the October 2026 leak (hundreds of redemptions of one
compensation code). Before this change only two things alerted: a coupon Yiji
**saved** as General although the CRM sent it Private (`alertNotPrivate`, the
Private check of 2 Nov) and the 3-hourly misuse check. A coupon an agent or a
supervisor made General **on purpose** went out silently. Now every General
coupon is told to the Administrators.

## What alerts, and when

| Coupon                                                                                   | Stage                                                                                                        | Where it is detected                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Compensation (`coupon_approvals`, `coupon_type` General or Public)                       | **requested** — the row was created, or changed, with a General type                                         | worker sweep `general_coupon_request_alert` (automation queue, every 2 min, rows created/updated in the last 24 h) |
|                                                                                          | **approved** — the push picks the approved/edited row up                                                     | `coupon-push.ts`, right after the type check                                                                       |
|                                                                                          | **created on Yiji** — `AddCoupon` / `CreateCouponUserFromOrder` succeeded (assigned, order-less or withheld) | `coupon-push.ts`                                                                                                   |
| Marketing (`marketing_coupons`, `audience` not `list` → `marketingCouponPayload` type 0) | **approved** — the sender picks the approved row up                                                          | `marketing-coupon-send.ts`                                                                                         |
|                                                                                          | **created on Yiji**                                                                                          | `marketing-coupon-send.ts`                                                                                         |

"General" uses the shared rule `isGeneralCouponType` (exactly `General` or
`Public`, any case). A **Private** coupon never alerts. A marketing **list**
coupon is Private on Yiji and never alerts.

The marketing stages run only when the marketing sender runs
(`MARKETING_COUPON_SEND=on`); with it off no marketing coupon reaches Yiji.

## Recipients and channel

Exactly those of `alertNotPrivate`: `alertAdministrators` (in
`coupon-misuse-check.ts`) queues one `notifications` job per **active user on
the Administrator role**, resolved by role _name_ — the built-in Administrator
role carries no privilege list, so resolving by privilege would reach nobody
(the "notification recipients trap"). The notifications worker then delivers it
like every other notification (in-app bell + the user's own channel choice).

## What the alert says

Title: `General coupon <stage>: <CODE> is General` (or `Marketing coupon …`).
Body: the code, **who created it** (`requested_by`, else `user_created`),
**who approved it** (`decided_by`; "not yet" at request time), the value
(`SAR 50` or `20% (max SAR 30)`), the customer phone if any, the ticket if any
(id, subject, order), and where to open it. Link: `/coupon-approvals` in the
admin portal for a compensation coupon; a marketing coupon has no admin page,
so the body points at the Marketing portal (Coupons) and the bell shows no
link. Payload: `{ kind: 'general_coupon', stage, source, couponApprovalId | marketingCouponId, codes }`.

## Dedupe — never a flood

One Redis key per coupon per stage,
`<env>:general-coupon-alert:<compensation|marketing>:<id>:<requested|approved|created>`,
`SET NX` with a 180-day expiry, claimed **before** the coupon is read — so a
push retried by the delivery sweep every minute, or the request sweep
re-reading the same row every 2 minutes, costs one Redis call and sends
nothing. The notification job id carries the same key as a second guard. A send
that fails (recipients unreadable, nobody to tell) releases the key so the next
pass retries. Without Redis the request sweep does not run at all (it would
repeat every pass); the push stages then fall back to the job-id guard.

A coupon can therefore produce at most three alerts (requested, approved,
created) — plus, separately and as before, the "blocked: not Private" alert when
Yiji saved a CRM-Private coupon as General.

## Alert only

Nothing here blocks, changes or delays a coupon. Every alert call is wrapped:
a failure is logged (`general coupon alert failed`) and the coupon carries on
exactly as before. A General coupon is still sent to Yiji as General.

## Why a worker sweep for the request stage (and not the Directus hook)

`notify-on-change` already watches `coupon_approvals.items.create` (the
high-value alert), but:

- the owner asked for the **same channel and recipients** as `alertNotPrivate`:
  the notifications queue and the Redis dedupe live in the workers; the hook is
  deps-free and writes notification rows directly;
- a hook change goes live only with a Directus restart (operational), and a
  hook that throws sits in the agent's save;
- the sweep is read-only, off the agent's path, and catches every writer the
  same way (agent portal, gateway, inbound API, an update that changes the type
  later).

Cost: one Directus read every 2 minutes (General/Public rows touched in the last
day, at most 100). `GENERAL_COUPON_ALERT_MS` tunes the interval; `0` removes the
scheduler (the approved/created alerts still fire from the push).

The agent portal is unchanged.

## Tests

`services/workers/tests/general-coupon-alert.test.ts` (text, dedupe, failure
releases the stage, request sweep incl. Private never alerting and no-Redis,
push stages incl. withheld and Private-check-blocked, alert failure never
blocks, two pushes wired to the real alert = one alert per stage) and
`services/workers/tests/marketing-coupon-send.test.ts` (code coupon alerts
approved + created, list coupon never, refusal = approved only, alert failure
never stops the coupon).
