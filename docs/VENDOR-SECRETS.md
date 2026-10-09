# Vendor secrets (MV-3, EMA-72)

Each vendor has its **own** webhook secret and its **own** chat-login (customer JWT) secret.
They live in **service configuration** (environment variables on the socket-gateway task), never
in the `vendors` table — storing secrets in the database waits for an approved encryption key.

## Naming convention

A vendor is named by its `webhook_path_key` (Vendors page; the `<key>` in `/webhooks/<key>`).

| Vendor            | Chat-login (JWT) secret   | Webhook secret                |
| ----------------- | ------------------------- | ----------------------------- |
| Yiji (key `yiji`) | `YIJI_JWT_SECRET`         | `YIJI_WEBHOOK_SECRET`         |
| any other `<key>` | `VENDOR_<KEY>_JWT_SECRET` | `VENDOR_<KEY>_WEBHOOK_SECRET` |

`KEY` = the path key upper-cased, every non-alphanumeric character replaced by `_`:
`acme-foods` → `VENDOR_ACME_FOODS_JWT_SECRET`, `VENDOR_ACME_FOODS_WEBHOOK_SECRET`.

**No fallback.** A vendor whose variable is missing or blank is refused (webhook 503, chat login
rejected, walk-in session 503). It is never given Yiji's secret.

Code: `packages/shared-types/src/vendor-secrets.ts`, `services/socket-gateway/src/vendor-auth.ts`.

### Platform API credentials (MV-7)

On the services that call the platform (**ai-gateway** and **workers**), same `KEY`, same
no-fallback rule:

| Vendor            | Order-API key / push key | Admin API login            | Admin API password            |
| ----------------- | ------------------------ | -------------------------- | ----------------------------- |
| Yiji (key `yiji`) | `YIJI_API_KEY`           | `YIJI_ADMIN_EMAIL`         | `YIJI_ADMIN_PASSWORD`         |
| any other `<key>` | `VENDOR_<KEY>_API_KEY`   | `VENDOR_<KEY>_ADMIN_EMAIL` | `VENDOR_<KEY>_ADMIN_PASSWORD` |

The env vendor (`yiji_vendor_id` = the service's vendor, `1`) always keeps the `YIJI_*` values
the service already has, whatever its `webhook_path_key`. A vendor without its variables has no
credential: its admin-API capabilities (coupon delivery, push, phone lookup, status history) are
`null`, never Yiji's. The NON-SECRET settings (order/admin API URLs, tenant, brand, notify URL /
topic / title / open-chat action) come from the vendor's record, each falling back to the
service's `YIJI_*` env value when blank (`RecordVendorSettingsSource` in
`packages/shared-types/src/connector.ts`).

## Webhooks

- `POST /webhooks/yiji` — unchanged (Yiji's route, `YIJI_WEBHOOK_SECRET`).
- `POST /webhooks/<key>` — any other active vendor. 404 unknown key, 503 no secret configured,
  401 bad signature, 202 accepted.

Signing (all vendors): `X-Yiji-Timestamp: <unix seconds>`,
`X-Yiji-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`, ±`WEBHOOK_TOLERANCE_SEC`.

## Customer chat login

The customer JWT (HS256) is verified with the secret of the vendor it claims in `vendor_id`
(the vendor's `yiji_vendor_id`). A token with **no** `vendor_id` is the legacy Yiji app and is
treated as the default vendor (`DEFAULT_VENDOR_ID`, `1` = Yiji). A token claiming vendor B but
signed with Yiji's secret is rejected.

Store QR page: `walk-in.html?vendor=<yiji_vendor_id>` opens a chat for that vendor; without the
parameter the build-time `VITE_WALK_IN_VENDOR_ID` (default `1`) is used, so printed Yiji codes
are unchanged. Personal links (`?c=<code>`) carry the vendor on the link row.

## Adding a vendor

1. Create the vendor (Administrator) with a `webhook_path_key`.
2. Add `VENDOR_<KEY>_JWT_SECRET` (≥ 32 chars) and `VENDOR_<KEY>_WEBHOOK_SECRET` to the
   socket-gateway task definition; redeploy.
3. Give the vendor its webhook URL `https://<gateway>/webhooks/<key>` and its JWT secret.
