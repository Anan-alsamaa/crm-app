# Late Delivery Handling

Automates what WeCare do by hand today: watching delivery orders that pass a
time threshold, and deciding what to do about each one.

Threshold: **60 minutes**, the same for every brand (owner, 2026-09-21).
Configurable — see [The threshold](#the-threshold) — but 60 is the value.

---

## What the agent sees

A new **Late orders** section in the agent portal top bar, listing live
delivery orders that have been running longer than the threshold. Each row
carries the order, the brand and branch, the customer, and how long it has
been running.

Two actions per row, both requiring a reason before they will commit:

| Action            | What it does                                                  |
| ----------------- | ------------------------------------------------------------- |
| **Ignore**        | Closes the row with a recorded reason. No ticket, no coupon.  |
| **Assign coupon** | Opens the same coupon form as Add ticket, same approval flow. |

A dropdown on each row classifies the delay as **late delivery** or **late
preparation**. The agent picks it — see [Classification](#classification).

### Every action raises a ticket

**A coupon cannot exist without a ticket.** Approval hard-refuses a ticket-less
request (`COUPON_APPROVAL_NO_TICKET`, `admin-portal/.../api.ts:223`) because
there is nowhere to put the coupon, and delivery to Yiji needs the ticket's
`order_id` (`coupon-push.ts:767`, outcome `no-order`). So **Assign coupon**
raises a ticket too, using the deferred `onCollect` path the Add-ticket form
already uses: collect the draft, create the ticket, then attach the request —
so a failed coupon never leaves a half-created ticket behind.

The ticket is prefilled either way:

| Field         | Value                                                                   |
| ------------- | ----------------------------------------------------------------------- |
| Ticket type   | `Instore preparation late order` (shown as "Late preparation in store") |
| Service type  | `Delivery`                                                              |
| Ticket source | `CRM`                                                                   |
| Contact       | the customer on the order                                               |
| Order number  | the order                                                               |
| Description   | the reason the agent typed                                              |

---

## Where the data comes from

Two Yiji endpoints, both measured live on 2026-09-21 rather than read off the
Swagger. `docs/` note: the findings are also in the session memory.

### The queue — `GET /api/Order/GetFilteredOrders`

```
DeliveryTypeIds=1                      # delivery
WithTotalServicesTimeFilterActive=60   # the threshold, in minutes
OrderFromDateFilter=<today>
OrderToDateFilter=<TOMORROW>           # EXCLUSIVE - passing today returns zero rows
```

**The filter measures elapsed-so-far on a live order**, which is the whole
feature. Verified by sweeping the threshold: at 30 the fastest live order was
29.6 min, at 45 it was 61.6 min. It is the same filter Yiji's own dashboard
uses (`MonitorVM.withTotalServicesTime60FilterActive`).

Two traps this endpoint carries:

1. **The date filter is exclusive.** Passing today as the end date returns
   nothing. A poller written the obvious way finds zero orders for ever and
   looks like it is working.
2. **It returns finished and cancelled orders too** — a `force_cancel` at
   3.1 min came back under a 60 filter. Status is filtered our side:
   live = `2,3,4,5,7,8,65`.

The response is a bare JSON array; the real order is nested under `order`.

### The order record — `GET /api/Order/GetOrderCart/{id}`

Full line items with modifiers, delivery address, money breakdown, coupon code,
and the delivery company's tracking URL. This is what fills Cart and Tracking
on an order record in the agent portal.

**Do not try to time the delivery legs from this payload.** `deliveryOrder`
looks like it carries them, but `pickupAt`, `atPickupAt`, `dropoffAt` and
`atDropoffAt` were null on every order measured, and `expectedPickup` is either
absent (`0001-01-01T00:00:00`) or in a different timezone from `creationTime`.
`orderDelayedMinutes` is always 0.

---

## Classification

The agent picks: **late delivery** or **late preparation**.

It is worth recording why this is manual, because the data to automate it does
exist. `GET /api/OrderStatusHistories/GetOrderStatusHistoriesByOrderId/{id}`
returns every status transition with its time, and the legs separate cleanly —
preparation is `in_kitchen`(5) until `ready_to_pickup`(7)/`in_delivery`(8),
delivery is `in_delivery`(8) until `delivered`(9). Measured:

```
1313926   in_kitchen 13:36 -> in_delivery 14:14   = 38.6 min preparation
1313738   kitchen->ready 19.4 min, delivery->delivered 25.4 min
```

The owner's call (2026-09-21) was to keep it manual. The timeline is shown to
the AGENT instead, in the expanded row — `in_kitchen 13:36 -> in_delivery
14:14` says "preparation" without anyone guessing. The reasoning: the predefined values make
the choice trivial for an agent, and a wrong auto-answer is worse than no
answer. The endpoint is already wired (`getOrderTimeline`), so prefilling the
dropdown later is a small change, not a redesign.

Note `arrived`(65) can repeat — three times on one measured order. Take the
FIRST occurrence of a status if this is ever automated.

---

## The threshold

Stored in `app_settings` under `late_delivery_minutes`, the same key/value
collection the WhatsApp template uses. Editable by operations without a deploy;
falls back to **60** when unset or unparseable.

Why a setting and not an env var: changing an env var is a deploy and a task
restart. The owner was explicit that 60 is the rule for all brands, so this is
not expected to change — but if it ever does, it should not need us.

---

## Real-time

No new machinery. The agent portal already polls every 30s and pauses on a
hidden tab (`apps/agent-portal/src/main.tsx`), and the commerce proxy in
`services/ai-gateway/src/commerce/` already caches through Redis with in-flight
coalescing, so ten agents watching the same queue cost one upstream call.

The queue is one cached call per poll, not one per order.

---

## Reporting

- **Ticket breakdown** gains a filter for late-preparation tickets. One report
  with a filter, not a second report (owner, 2026-09-21).
- **Agent KPI** gains a late-orders measure: how many an agent handled, and how
  they were resolved.
- Operations see the operational KPI only.

---

## What shipped

Live on staging and production 2026-09-21 (`c3e615f` … `c09ca70`).

### The agent's queue

`/late-orders`, in the top bar to the right of Tickets. Click the order number
to open its **cart** (every line with the choices behind it — "Without
Broccoli, Without Olives") and its **tracking** (the real status timeline).
The panel mounts only when opened and both calls are cached server-side, so an
unopened row costs nothing.

### Three bugs found only by running it on staging

Each rendered as a plausible number rather than an error:

1. **The threshold was never read.** `svc-ai-gateway` had no grant on
   `app_settings`; the read 403'd, fell back to 60, and the queue reported a
   threshold nobody set. Found by CHANGING the setting and watching nothing
   happen.
2. **Every order read three hours in the future.** Yiji's timestamps are
   Riyadh-local with no zone marker; the UTC container read them wrong. The
   silent half is worse than the `-141`: an order genuinely three hours late
   reads as minutes old and never enters the queue at all.
3. **A compensation claimed before its coupon existed.** Opening the coupon
   form and closing it left a permanent row saying the customer was
   compensated. The decision is now written from the form's `onCreated`.

### Deploying this anywhere else

Schema and permissions do NOT ride a deploy:

```
DIRECTUS_INTERNAL_URL=<env>  pnpm --filter @yiji/directus-bootstrap run apply
```

`DIRECTUS_INTERNAL_URL` is the variable that matters — `DIRECTUS_URL` is
silently ignored. Afterwards confirm by reading back, not by trusting the run:
the `late_order_decisions` grants, `svc-ai-gateway`'s `app_settings` read, and
`coupon_approvals.order_id`. Then create `late_delivery_minutes` in
`app_settings` (absent = 60, so the feature works either way; the row exists so
operations can see and change it).

**A COMPLETED ECS rollout is not proof the new code is running** — compare the
ECR digest against the task's `containers[0].imageDigest`. A push to the
mutable `:main` tag after a rollout restarts nothing.
