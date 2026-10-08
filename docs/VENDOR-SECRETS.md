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
