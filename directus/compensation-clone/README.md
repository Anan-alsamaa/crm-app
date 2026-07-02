# Compensation clone (local Directus)

Reproducible clone of the production **`compensation_requests`** collection + its
dependencies + the agent workflow, into a local Directus, so the agent-portal
Compensation section can be built and tested without touching production.

## What it clones

**5 collections** (schema only, extracted read-only from prod → `schema/*.json`):

- `compensation_requests` — the request (customer/order/complaint/money/status)
- `Com_Coupons` — coupons (target of "generate/assign coupon")
- `com_issues_list`, `Com_Issue_Categories` — complaint taxonomy
- `Compensation_Request_items` — line items (o2m)

Relations to `directus_users` / `directus_files` / `sla_policies` are reused
(they already exist locally). Directus admin-form layout fields (groups/tabs/
header/links + o2m aliases) are intentionally **not** cloned — the portal renders
its own UI.

## The workflow — Directus manual Flows (the "button" API)

See `flow-contract.json`. Each agent action is a manual flow triggered by:

```
POST {DIRECTUS_URL}/flows/trigger/{flowId}
{ "collection": "compensation_requests", "keys": ["<requestId>"], ...inputs }
```

Flow **IDs are identical in prod and local** (preserved on purpose), so the
portal triggers by id and works against whatever `VITE_DIRECTUS_URL` points at.

| Action                 | Effect                             | Inputs                                          |
| ---------------------- | ---------------------------------- | ----------------------------------------------- |
| Acknowledge            | → In Progress                      | —                                               |
| Calculate compensation | fills suggested value              | —                                               |
| Generate coupon        | **prod:** Yiji CreateCoupon + link | coupon_name, coupon_code, side, date_from(+opt) |
| Assign coupon          | links coupon                       | —                                               |
| Accept                 | → Approved                         | —                                               |
| Reject                 | → Rejected                         | reason\*                                        |
| Refund amount          | refund                             | reason                                          |

## Prod vs local execution

- **Production**: the portal points at prod Directus; flows run the real logic
  (scripts, the Yiji `CreateCoupon` HTTP call, notifications). Directus is the
  source of truth. Ops agents never open Directus — they use the portal.
- **Local (dev)**: `standin-flows.mjs` creates same-id stand-in flows that apply
  only the visible status/field transition — **no external calls**, so
  "Generate coupon" never hits real Yiji during development.

## Reproduce on a fresh local Directus

```bash
# creds default to the local dev admin; override via env if needed
node directus/compensation-clone/apply-local.mjs     # 5 collections + relations
node directus/compensation-clone/standin-flows.mjs   # 7 safe stand-in flows (same ids)
node directus/compensation-clone/seed.mjs            # synthetic sample requests
```

All three are idempotent. Nothing here writes to production.
