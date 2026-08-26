# Running a campaign off CRM data

_Written 2026-08-26, against the live database. Every number below was measured,
not estimated — re-measure before acting on this, because the shape of the data
is the whole argument._

The question: _we want to run a marketing campaign for customers who complained
about a specific item, or a specific type, or similar — how do we use the CRM
data?_

Short answer: **the targeting already works, the delivery already works for one
channel, and the thing actually stopping you is consent — which does not exist
in this database at all.**

---

## What you can segment on today

Measured over 64 tickets:

| Dimension            | Where it lives                      | Coverage | Usable?                                              |
| -------------------- | ----------------------------------- | -------- | ---------------------------------------------------- |
| Complaint type       | `tickets.complaint_type`            | 64/64    | **Yes** — 14 values, operations-editable             |
| Service type         | `tickets.service_type`              | most     | **Yes** — Delivery, Pickup, Carhop, Takeout, Dine-in |
| Brand                | `tickets.order_snapshot->brandName` | 59/64    | **Yes**                                              |
| Branch               | `tickets.store` + snapshot          | most     | **Yes**                                              |
| Area / chain manager | via the store master                | most     | Yes, for operational campaigns                       |
| Compensated or not   | `tickets.compensation`              | all      | **Yes** — "we already paid them" is a real segment   |
| **Specific item**    | `order_snapshot->items`             | **9/64** | **Weak — see below**                                 |

A realistic segment right now, by complaint type:

```
Missing item        24 customers   24 with an order
Accuracy            22            22
Cleanness            6             2
Missing condiments   3             3
Late order           2             2
Foreign object       2             2
```

Small numbers because the database is young. The _mechanism_ is what matters,
and it works.

### The item gap is the one real weakness

You asked specifically about "a specific item", and that is the weakest column:

- `order_snapshot.items` is populated on **9 of 64** tickets. The snapshot is
  frozen at ticket creation, and when the order lookup returns nothing the items
  array is written empty. Those tickets can never be segmented by item.
- `coupon_approvals.item_name` is **free text**. It currently holds `Water`,
  and `Vegetable Pasta.yy` — a typo that is now a permanent distinct value. Any
  "customers who complained about X" query splits across spellings.

**If item-level campaigns matter, that is the thing to fix first**, and it is a
small fix: the order line already carries a real Yiji item id
(`idChooseableItem`, e.g. 1047 = Water). Storing that id beside the name would
make items groupable properly and immune to typos. Until then, item targeting is
best-effort on a tenth of the data.

---

## How you would actually reach them

Three channels exist, in descending order of proof.

**1. A Yiji coupon — proven, and the strongest option.**

This is the one that already works end to end (receipts 21207, 21223, 21229 are
real). The crucial detail:

> `CreateCouponUserFromOrder` needs an **ORDER id**, not a customer id.

That matters enormously here. Only **8 of 64** contacts carry a Yiji customer id
(`external_customer_id`) — walk-ins have none and cannot be looked up from a
phone. If coupons needed a customer id, this whole idea would cover an eighth of
your customers. Because they hang off the order, **every ticket with an
`order_id` is reachable** — which is essentially all of them.

So the campaign shape that works today is: _segment tickets → take their order
ids → issue a coupon against each order_. Yiji notifies the customer itself.

**2. WhatsApp — exists, but manual.** `WhatsAppReply.tsx` opens a `wa.me` link
per contact. Fine for a handful, not a campaign.

**3. Email — SMTP is configured**, but contact emails are sparse and many are
Yiji-generated addresses (`Nada6@yiji.com`) that nobody reads.

---

## The blocker: there is no consent

I searched every table for a consent, opt-out, subscription or marketing-
preference column. **There are none.**

Everyone in `contacts` is there because they _complained_, not because they
opted into marketing. Sending them promotional messages on that basis is a
different thing from apologising to them, and in most jurisdictions —
Saudi PDPL included — it needs a lawful basis you do not currently record.

This is not a technical obstacle I can code around, and it should not be worked
around. Before any campaign:

1. **Decide the lawful basis** with whoever owns compliance.
2. **Add consent to `contacts`** — at minimum `marketing_consent` (bool),
   `consent_source` (where it came from), `consent_at`. Without provenance a
   consent flag is just an assertion.
3. **Honour opt-out** — one column, checked by every send, no exceptions.

A campaign tool built before this exists is a liability, so I have not built one.

---

## What I would build, in order

1. **Store the Yiji item id** on tickets and coupon approvals. Small, and it is
   what makes "customers who complained about item X" a real query rather than a
   text search. Fixes the weakest column.
2. **Consent fields + opt-out**, per above. The gate on everything else.
3. **A saved-segment view** in the admin portal. The reports layer already has
   the filters (type, service, brand, branch, date) — this is mostly exposing
   what exists and letting someone name and re-run a cut.
4. **Bulk coupon issue from a segment**, reusing the proven push. Given the
   owner's standing rule that no coupon is ever issued without asking, this must
   be _propose → review the list → confirm_, never a one-click blast. The
   existing high-value alert (over SAR 200) should fire per coupon regardless.

Steps 1–3 are safe to do now. Step 4 should wait for step 2.

---

## One caution about the idea itself

Targeting people who complained is a sharp instrument. "You complained about a
missing item, here is 20% off" reads as an apology to some and as _we noticed
you were annoyed and are trying to buy you back_ to others — particularly if
they already received a compensation coupon for the same ticket.

`tickets.compensation` records who was already compensated, and excluding them
is one filter. Worth deciding deliberately rather than discovering from replies.
