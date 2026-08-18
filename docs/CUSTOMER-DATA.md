# Customer behaviour & interaction data

The CRM is the long-term store of customer behaviour. Little of this is
consumed today, but it is retained in a structured, queryable form so future
capabilities — behaviour analysis, personalised coupons, segmentation,
behaviour-based campaigns — can be built on data that already exists rather
than data that starts accruing the day someone asks for it.

## What is stored, and where

| Behaviour                | Collection(s)                                                                    | Notes                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                 | `contacts`                                                                       | Name, phone, email, `external_customer_id` (the Yiji key), vendor link, tags.                                                                                                                                                          |
| Conversations            | `conversations`                                                                  | One long-lived thread per customer. Status, priority, assignment, `last_order_snapshot`, CSAT link. Archived (flag), **never deleted**.                                                                                                |
| Every message            | `messages`                                                                       | Full text, sender type, timestamps, attachments (`messages_files`). The widget shows customers only the last 7 days — a **display** cap, not a retention cap; agents and the database keep everything.                                 |
| Complaints / tickets     | `tickets`                                                                        | The full ops template: complaint type/source/date, service type, description, response, resolution, order id + `order_snapshot` (line items, totals), branch link + frozen `store_snapshot`, compensation fields.                      |
| Ticket lifecycle         | `ticket_events`                                                                  | Append-only audit history (no update/delete in any role).                                                                                                                                                                              |
| Field-level edit history | `directus_revisions`                                                             | "Who changed what" for tickets and coupon approvals. Both are in `KEEP_FOREVER` in `directus/bootstrap/scripts/prune-audit.mjs` — the audit prune never touches them.                                                                  |
| Compensation / coupons   | `coupon_approvals`                                                               | Every request whatever its fate (pending/approved/edited/rejected/assigned), full terms (dates, category, value/percent, delivery types, item, brand/branch), requester, decider, amendment flag. Rejected rows are kept deliberately. |
| Branch notifications     | `store_notifications`                                                            | What each branch was told about a complaint, with order items. Outbox — rows are never rewritten.                                                                                                                                      |
| Satisfaction             | `csat_responses`                                                                 | Per-conversation CSAT.                                                                                                                                                                                                                 |
| Order history            | Yiji (upstream) + `tickets.order_snapshot` + `conversations.last_order_snapshot` | Yiji owns live orders; the CRM freezes point-in-time copies wherever a decision was made against one.                                                                                                                                  |

## Retention guarantees

- **Nothing behavioural is pruned.** The only deletion job in the system is
  `prune:audit`, which trims `directus_revisions` / `directus_activity`
  bookkeeping older than a window — and holds `tickets` and `coupon_approvals`
  history forever (see `KEEP_FOREVER`).
- **Archiving is a flag** (`conversations.archived_at`), not a move or a
  delete. Archived chats stay fully queryable.
- **Customer-facing limits are views, not truth.** The chat widget seeds only
  the last 7 days; the inbox "Linked tickets" panel shows only the newest 3.
  The underlying rows are untouched and reachable through reports.

## Where to read it back today

- Admin → Compensation: the master coupon record, filterable + CSV export.
- Admin → Reports: the complaints export (full ops template columns).
- Admin → Ticket report / Agent KPIs: aggregates over the same rows.
- Ticket page: field history and "last modified by", derived from revisions.
