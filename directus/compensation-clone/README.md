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

The portal is the **trigger surface**; all logic lives in the Directus flow.
Most actions are **one-click** (no inputs). The few prod flows that require the
operator to fill fields in Directus' manual-trigger dialog present those **same
fields as a form in the portal** (see each action's `inputs` in
`apps/agent-portal/.../compensation/actions.ts`) and send the values in the
trigger body — so nothing has to be typed in Directus:

| Action          | Manual inputs (required\*)                                                     |
| --------------- | ------------------------------------------------------------------------------ |
| Reject          | reason\*                                                                       |
| Generate Coupon | coupon_name\*, coupon_code\*, side\*, date_from\*, date_to, time_form, time_to |
| Close task      | reason                                                                         |

Flow **IDs are identical in prod and local** (preserved on purpose), so the
portal triggers by id and works against whatever `VITE_DIRECTUS_URL` points at.
Button order/labels/inputs mirror the prod `links-ycdmfv` bar + each flow's
trigger dialog exactly.

| Button (portal)        | Flow id   | Effect (status →)                                  |
| ---------------------- | --------- | -------------------------------------------------- |
| Acknowledge            | f6fc9809… | Acknowledged                                       |
| Accept                 | 6482d337… | Accepted                                           |
| Reject                 | 9335c8fb… | Rejected                                           |
| Calculate Compensation | 90a0639c… | Calculating Compensation (+ suggested value)       |
| Generate Coupon        | fd7dd27e… | Generating Coupon (prod: Yiji CreateCoupon + link) |
| User Assign Coupon     | 9a09201e… | Assign Coupon to User                              |
| Close task             | 13011877… | Closed                                             |

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
node directus/compensation-clone/apply-local.mjs      # 5 collections + relations
node directus/compensation-clone/standin-flows.mjs    # 7 safe stand-in flows (same ids); add --force to recreate after changing inputs
node directus/compensation-clone/layout-local.mjs     # admin form layout: tabs, super-header, button bar
node directus/compensation-clone/grant-agent-perms.mjs # Agent role: read on the 5 collections (portal queue)
node directus/compensation-clone/seed.mjs             # synthetic sample requests
```

All are idempotent. Nothing here writes to production.

## Directus admin buttons (parity note)

The action buttons on the item page come from the `links-ycdmfv` (presentation-links, actionType=flow) + `header-crt4xp` (super-header) fields. `presentation-links` is core Directus; `super-header` is a marketplace extension (`@directus-labs/super-header-interface`) that a fresh local Directus may lack. It's installed in this environment (dropped into `crm-app-infra/directus/extensions/`); on a fresh setup, install it via Settings → Marketplace (or npm pack into that folder) + restart Directus. The fields + flow ids are already in place, so the buttons render and trigger the SAFE local stand-in flows.
