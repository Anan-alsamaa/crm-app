# Multi-vendor: onboarding a vendor, and the staging test vendor (EMA-69, MV-6)

One CRM, one set of agents, many vendors; a vendor's data is never mixed with another's. Each
vendor runs on a commerce **platform**, and the platform's **connector** (in
`packages/shared-types/src/connector.ts`) turns that platform's API into the CRM's standard shapes.

**How the connector is chosen:** `vendors.platform` -> `ConnectorRegistry` factory for that
platform. `yiji` -> `YijiConnector`; `mock` -> `MockConnector` (only with `ALLOW_MOCK_VENDORS=true`);
anything else -> refused (`unsupported_platform`). A refused vendor is **never** answered by
another platform's connector. A NULL platform reads as `yiji` (every vendor before MV-1).

## Onboarding a real vendor

1. **Connector.** Write `<Platform>Connector implements VendorConnector` (orders, customers, cart
   with modifiers, late orders, coupon + push capabilities, or `null` where the platform has none).
   Register it in `DEFAULT_FACTORIES`, add the platform to `CommercePlatform` / `COMMERCE_PLATFORMS`,
   to `vendors.platform` choices (`directus/bootstrap/src/collections.ts`), to the Vendors page
   select (`apps/admin-portal/src/features/vendors/VendorsPage.tsx`) and to `KNOWN_PLATFORMS`
   (`scripts/release-check/lib/vendor-checks.mjs`). The workers' coupon/push processors speak
   Yiji's payloads: `asCouponPushConnector` refuses a new platform until it has its own
   coupon/push code. Tests: copy `packages/shared-types/tests/mock-connector.test.ts`.
2. **Vendor row.** Administrator -> Vendors page: name, platform, platform vendor id
   (`yiji_vendor_id`), `webhook_path_key`, integration settings (non-secret only).
3. **Secrets** (owner approval: AWS task-definition change). On **svc socket-gateway**:
   `VENDOR_<KEY>_JWT_SECRET` (>= 32 chars) and `VENDOR_<KEY>_WEBHOOK_SECRET`, `KEY` = the
   webhook key upper-cased, non-alphanumerics -> `_` (docs/VENDOR-SECRETS.md). Platform API
   credentials go on the services that call the platform (ai-gateway, workers).
4. **Release checks.** `scripts/release-check/regressions.mjs` runs per vendor automatically:
   connector resolves, cross-vendor isolation (contacts, conversations, tickets, coupons), and for
   a mock vendor the mock commerce / chat login / webhook. All read-only on production.

## The staging test vendor

"Test Vendor": platform `mock`, `yiji_vendor_id` `test-1`, webhook key `test`, brand `TV-MOCK`,
stores `TV-001` / `TV-002`. The `MockConnector` makes **zero network calls**: deterministic
customers (`mock-cust-1..3`, phones `0500000101..103`; any other Saudi mobile becomes
`mock-5XXXXXXXX`), orders `MOCK-1001..1004` with modifiers, carts, late orders (MOCK-1001 at 95 min,
MOCK-1003 at 70 min), and a coupon/push transport that records in memory and answers "yes" in
Yiji's shapes, so the real coupon processor runs end to end. Nothing it holds survives a restart.

**Order of operations** (each needs the owner's go-ahead on staging):

1. Deploy MV-6 to staging and apply the permission edit below. The seed script **refuses** until
   both registries can read `vendors.platform`: older code reads the vendor without its platform,
   takes it for Yiji and would send its lookups and coupons to Yiji's production API.
2. `API=https://crm-api-staging.anan.sa ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/seed-test-vendor.mjs`
   (dry run), then `--write`. Refuses any host but `crm-api-staging.anan.sa`; idempotent.
3. Clean-up: `--remove` (dry run) then `--remove --write`. It deletes every row of the test vendor
   in every vendor-scoped table **before** the vendor: deleting the vendor alone would set those
   rows' vendor to NULL, which means "legacy Yiji" (an approved test coupon would be pushed to
   real Yiji) or "every vendor" (quick replies, SLA policies).

### Live edits this change needs (per environment, owner approval)

| Where                                                        | Edit                                                    | Staging             | Prod      |
| ------------------------------------------------------------ | ------------------------------------------------------- | ------------------- | --------- |
| Directus permission, policy `svc-ai-gateway`, `vendors` read | add field `platform`                                    | yes                 | yes       |
| Directus permission, policy `svc-workers`, `vendors` read    | add field `platform`                                    | yes                 | yes       |
| Directus field `vendors.platform`                            | choices `yiji`, `mock` (UI only; not enforced)          | yes                 | yes       |
| Env `ALLOW_MOCK_VENDORS=true`                                | svc **ai-gateway** and svc **workers** task definitions | to prove mock       | **never** |
| Env `VENDOR_TEST_JWT_SECRET` (>= 32 chars)                   | svc **socket-gateway** task definition                  | to prove chat login | never     |
| Env `VENDOR_TEST_WEBHOOK_SECRET`                             | svc **socket-gateway** task definition                  | to prove webhook    | never     |

Without the permission the code is safe but degraded: the services' vendors read is refused as a
whole, they fall back to the env vendor (`1`, Yiji) with a logged warning, and requests naming a
vendor by UUID answer 404 `unknown_vendor`. `ALLOW_MOCK_VENDORS=true` against production Directus
stops the service at startup.

### What staging proves with and without the AWS env changes

- **Without** (code + permission only): registry picks by platform; the mock vendor is **refused**
  (never Yiji); isolation probes across Yiji and the test vendor; the test vendor's agent-side
  views (badges, filters, vendor-scoped quick replies/SLA). The release checks report the mock
  commerce, chat-login and webhook parts as **SKIP**, naming the missing variable.
- **With** `ALLOW_MOCK_VENDORS` (ai-gateway, workers): mock orders/carts/late orders in the
  portals; a coupon for a test-vendor customer delivered into the mock's memory.
- **With** `VENDOR_TEST_*` (socket-gateway): the test vendor's customer chat login
  (`POST /chat/session` with `vendorId: test-1`) and its signed webhook.

Note: with the test vendor active, staging has two active vendors, so
`scripts/backfill-vendor.mjs` refuses (by design) until it is removed or deactivated, and an
approved test-vendor coupon stays `approved` while `ALLOW_MOCK_VENDORS` is unset, which the
EMA-23 "stuck coupon" release check reports after 15 minutes.
