# Sara CRM — Yiji inbound API (tickets + coupon requests)

For Yiji's engineering team. Lets Yiji raise a complaint ticket in the CRM, optionally with a
compensation coupon **request**, and read back what became of it.

| Environment | Base URL                                        |
| ----------- | ----------------------------------------------- |
| Staging     | `https://crm-api-staging.anan.sa/webhooks/yiji` |
| Production  | `https://crm-api.anan.sa/webhooks/yiji`         |

| Method | Path                            | What it does                                  |
| ------ | ------------------------------- | --------------------------------------------- |
| POST   | `/tickets`                      | Create a ticket, optionally with one coupon   |
| POST   | `/tickets/{externalId}/coupons` | Add a coupon to a ticket you created earlier  |
| GET    | `/tickets/{externalId}`         | Ticket status + every coupon and its decision |

`{externalId}` is **your** ticket id (URL-encode it).

**Coupons are requests.** A coupon arrives `pending` and is delivered to the customer's Yiji
wallet by the CRM only after a WeCare supervisor approves it. Poll `GET /tickets/{externalId}` for
the decision. The CRM never calls Yiji from these endpoints.

## Authentication — HMAC-SHA256

Every request carries two headers:

```
X-Yiji-Timestamp: <unix seconds, now>
X-Yiji-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the shared secret>
```

- Sign the **exact bytes** you send as the body. For `GET` the body is empty, so you sign
  `"<timestamp>."`.
- The timestamp must be within **±300 seconds** of the CRM's clock (replay protection).
- The secret is shared out of band (one per environment). Never put it in a URL or log.
- `Content-Type: application/json` on every POST. HTTPS only.

**Node.js**

```js
import crypto from 'node:crypto';

async function callCrm(method, path, bodyObj) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto
    .createHmac('sha256', process.env.CRM_INBOUND_SECRET)
    .update(`${ts}.${body}`)
    .digest('hex');
  const res = await fetch(`https://crm-api-staging.anan.sa/webhooks/yiji${path}`, {
    method,
    headers: {
      'X-Yiji-Timestamp': ts,
      'X-Yiji-Signature': `sha256=${sig}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body || undefined,
  });
  return { status: res.status, json: await res.json() };
}
```

**C#**

```csharp
using System.Security.Cryptography;
using System.Text;

static async Task<HttpResponseMessage> CallCrm(HttpClient http, HttpMethod method, string path, string? json)
{
    var body = json ?? "";
    var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
    var sig = Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes($"{ts}.{body}"))).ToLowerInvariant();
    var req = new HttpRequestMessage(method, $"https://crm-api-staging.anan.sa/webhooks/yiji{path}");
    req.Headers.Add("X-Yiji-Timestamp", ts);
    req.Headers.Add("X-Yiji-Signature", $"sha256={sig}");
    if (json != null) req.Content = new StringContent(json, Encoding.UTF8, "application/json");
    return await http.SendAsync(req);
}
```

Send the same string you signed (`body`), not a re-serialised object.

## POST /tickets

```json
{
  "externalId": "YT-1001",
  "customer": { "phone": "+966501234567", "name": "Sara", "yijiCustomerId": "77881" },
  "orderNumber": "1280043",
  "restaurantId": "501",
  "restaurantName": "LCP-002 Marina Mall 2",
  "subject": "Missing fries",
  "description": "The fries were missing from the order.",
  "complaintType": "Missing item",
  "serviceType": "Delivery",
  "attachments": ["https://cdn.yiji.example/p/1.jpg"],
  "occurredAt": "2026-10-27T13:30:00+03:00",
  "coupon": {
    "externalId": "YC-9001",
    "type": "amount",
    "value": 25,
    "validFrom": "2026-10-27",
    "validTo": "2026-11-27",
    "reason": "Missing item"
  }
}
```

| Field                         | Req. | Notes                                                                                                                                                                                                                                                     |
| ----------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `externalId`                  | yes  | Your ticket id. 1–100 chars: letters, digits, `. _ : -`. The idempotency key.                                                                                                                                                                             |
| `customer.phone`              | yes  | Saudi mobile in any common form (`05…`, `+9665…`, `9665…`).                                                                                                                                                                                               |
| `customer.name`               | no   | Customer's name.                                                                                                                                                                                                                                          |
| `customer.yijiCustomerId`     | no   | Your user id — lets an approved coupon reach the right wallet. Strongly recommended.                                                                                                                                                                      |
| `orderNumber`                 | no   | The order the complaint is about.                                                                                                                                                                                                                         |
| `restaurantId`                | yes  | Your restaurant id. Must map to a CRM branch (see 422 below).                                                                                                                                                                                             |
| `restaurantName`, `brandName` | no   | Help match a branch whose id is not yet in the CRM's store master.                                                                                                                                                                                        |
| `subject`                     | no   | Defaults to the complaint type.                                                                                                                                                                                                                           |
| `description`                 | no   | Up to 5000 chars.                                                                                                                                                                                                                                         |
| `complaintType`               | yes  | One of: Accuracy, Cleanness, Driver attitude, Foreign object found, Hospitality, Instore preparation late order, Late order, Missing condiments, Missing item, Order cold, Order Late in store, Product, Roach found, Technical issue (case-insensitive). |
| `serviceType`                 | no   | Delivery, Dinning (dine-in), Drive Thru, Pickup, TakeOut.                                                                                                                                                                                                 |
| `attachments`                 | no   | Up to 10 `https://` URLs. Listed on the ticket as links; the CRM does not download them.                                                                                                                                                                  |
| `occurredAt`                  | no   | ISO 8601 date-time of the incident.                                                                                                                                                                                                                       |
| `coupon`                      | no   | One coupon for this ticket (optional). The ticket is created whether or not the coupon is valid (see below).                                                                                                                                              |

**Coupon object** (same body for `POST /tickets/{externalId}/coupons`):

| Field                  | Req.       | Notes                                                                       |
| ---------------------- | ---------- | --------------------------------------------------------------------------- |
| `externalId`           | yes        | Your coupon id. Unique across all your coupons. The idempotency key.        |
| `type`                 | yes        | `amount` or `percentage`.                                                   |
| `value`                | amount     | SAR off, > 0. (`maxDiscount` defaults to it.)                               |
| `percent`              | percentage | 0 < percent ≤ 100.                                                          |
| `maxDiscount`          | percentage | Ceiling in SAR, > 0. For an amount it may not be below `value`.             |
| `validFrom`, `validTo` | no         | `YYYY-MM-DD`, whole days inclusive. Default: today → same day next month.   |
| `reason`               | no         | Why. Defaults to the ticket description. Shown to the approving supervisor. |
| `deliveryTypes`        | no         | Any of `All, Delivery, Pickup, Carhop, Takeout, Dine-in`. Default `All`.    |
| `item`                 | no         | `{ "name": "Fries", "sku": "123" }` — the order line it compensates.        |
| `issuingSide`          | no         | Default `Customer Care`.                                                    |
| `audience`             | no         | `private` (default) or `general`.                                           |
| `usageLimit`           | no         | Times it can be used, default 1.                                            |
| `noOtherDiscounts`     | no         | `true` = cannot be combined with other offers. Default `false`.             |

**The ticket never depends on its coupon.** A ticket is always created when its own fields are
valid; tickets without a coupon are normal. If a `coupon` is sent but cannot be created (invalid
terms, a policy rule, an `externalId` already used, or a temporary error), the ticket is still
created - shown as _Not Compensated_ - and the reply's `coupon` says why:

```json
{
  "ticketId": "…",
  "ticketNumber": "1E5C5323",
  "externalId": "YT-1001",
  "coupon": {
    "status": "not_created",
    "error": {
      "code": "invalid_coupon",
      "message": "The coupon is invalid.",
      "fields": { "coupon.maxDiscount": "A percentage coupon needs a maximum discount." },
      "retryable": false
    }
  }
}
```

Fix the coupon and send it with `POST /tickets/{externalId}/coupons` (or resend this request with
the same ticket `externalId` - you get the same ticket back with the coupon added). A coupon is
always pending a WeCare supervisor's approval, exactly like one raised by an agent in the CRM.

**201 Created**

```json
{
  "ticketId": "1e5c5323-cafc-418c-9988-72f0a3fbd896",
  "ticketNumber": "1E5C5323",
  "externalId": "YT-1001",
  "coupon": { "id": "…uuid…", "externalId": "YC-9001", "code": "CC-7K3M9QXA", "status": "pending" }
}
```

## POST /tickets/{externalId}/coupons

Body: one coupon object. `201` with `{ ticketId, ticketNumber, externalId, coupon }`.
`404` if the ticket was never created through this API — a coupon is never stored without a ticket.

## GET /tickets/{externalId}

```json
{
  "ticketId": "…",
  "ticketNumber": "1E5C5323",
  "externalId": "YT-1001",
  "status": "pending",
  "compensation": "Compensated",
  "createdAt": "2026-10-27T10:00:00.000Z",
  "solvedAt": null,
  "coupons": [
    {
      "id": "…",
      "externalId": "YC-9001",
      "code": "CC-7K3M9QXA",
      "status": "approved",
      "value": 25,
      "percent": null,
      "maxDiscount": 25,
      "validFrom": "2026-10-27",
      "validTo": "2026-11-27",
      "decisionNote": null,
      "decidedAt": "2026-10-27T11:02:00.000Z",
      "createdAt": "…"
    }
  ]
}
```

- Ticket `status`: `pending` | `solved`.
- Coupon `status`: `pending` (waiting for a supervisor) · `approved` (granted; delivery queued) ·
  `assigned` (in the customer's Yiji wallet) · `rejected` (see `decisionNote`) · `removed` (taken
  back) · `replaced` (a supervisor edited it; the replacement appears as another coupon with
  `externalId: null` and a new `code`).
- Poll gently (e.g. every few minutes, not per second).

## Idempotency and retries

- Same ticket `externalId` again → **200** with the ticket already created; nothing new is written.
  If that request also carries a coupon the ticket does not have yet, the coupon is added.
- Same coupon `externalId` again on the same ticket → **200** with the existing coupon.
- The first request wins: a replay with different content does **not** update the stored record.
- Retry on `429`, `503` and network errors with the **same body** (new timestamp + signature),
  with back-off (e.g. 1 s, 5 s, 30 s, 2 min). Do not retry `400`, `401`, `404`, `409`, `422`
  without fixing the request.

## Errors

All errors are JSON: `{ "error": "<code>", "message": "…", "fields": { "<field>": "<message>" } }`.

| HTTP | `error`                          | Meaning                                                                                                                                                              |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `validation_failed`              | See `fields`, e.g. `{"coupon.maxDiscount": "A percentage coupon needs a maximum discount…"}`                                                                         |
| 400  | `invalid_request`                | Body is not valid JSON.                                                                                                                                              |
| 401  | `invalid_signature`              | Bad/missing signature, or timestamp outside ±300 s.                                                                                                                  |
| 404  | `ticket_not_found`               | No ticket with that `externalId`.                                                                                                                                    |
| 409  | `coupon_external_id_conflict`    | (Add-coupon call) that coupon `externalId` already belongs to another ticket. On ticket creation this is reported in `coupon.error` and the ticket is still created. |
| 415  | `invalid_request`                | Missing `Content-Type: application/json`.                                                                                                                            |
| 422  | `unknown_restaurant`             | `restaurantId` maps to no CRM branch. Ask the CRM team to map it.                                                                                                    |
| 422  | `policy_violation`               | (Add-coupon call) coupon outside the CRM's compensation policy, only when enabled. On ticket creation it is reported in `coupon.error`.                              |
| 429  | `rate_limited`                   | Too many requests; honour `Retry-After`.                                                                                                                             |
| 503  | `not_configured` / `unavailable` | Temporarily unable to process. Safe to retry the same request.                                                                                                       |
