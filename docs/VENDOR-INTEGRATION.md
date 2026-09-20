# Integrating an app with the CRM chat

How a customer-facing app opens a CRM chat for one of its customers, and what a
SECOND app would need. Written for whoever integrates next — today that is Yiji
(the EG app), and everything here is what Yiji already does.

## The one endpoint

```
POST https://crm-api.anan.sa/chat/session
content-type: application/json
```

That is the name to give an integrator. `/walk-in/session` and
`/walk-in/chat-session` are the same endpoint under older spellings; they still
work and are not going away, because the app calls one of them today.

A PATH ONLY EXISTS IF THE LOAD BALANCER ROUTES IT. `/chat/*`, `/walk-in/*`,
`/jobs/*`, `/webhooks/*`, `/teams/*` and `/debug/*` are the only prefixes sent
to this service; anything else reaches Directus and is answered with
`ROUTE_NOT_FOUND` — the endpoint would exist, run, and never be reached. Adding
a new prefix means an ALB rule FIRST, then the code.

### Body

| field              | required    | what it is                                                    |
| ------------------ | ----------- | ------------------------------------------------------------- |
| `phone`            | **yes**     | The customer's number. The only mandatory field.              |
| `vendorId`         | recommended | Which app this is. `"1"` = Yiji/EG. Omitted means `"1"`.      |
| `customerId`       | when known  | The customer's id **in your platform**. See below.            |
| `yijiSessionToken` | optional    | Your own session token, if you would rather not assert an id. |
| `name`, `email`    | optional    | Stored on the contact. Cosmetic.                              |
| `entryPoint`       | optional    | `"app"` or `"store_qr"`. Defaults to `store_qr`.              |

### Response

```json
{ "ok": true, "token": "<jwt>" }
```

Navigate the customer to the chat page with that token. It lasts **12 hours**
and cannot be refreshed in place, so mint it when the customer opens the chat,
not in advance.

## The two doors, and why they differ

|            | from the app                         | from a branch QR code                    |
| ---------- | ------------------------------------ | ---------------------------------------- |
| sends      | `customerId` (or `yijiSessionToken`) | `phone` only                             |
| token says | `walk_in: false`, `entry_point: app` | `walk_in: true`, `entry_point: store_qr` |
| past chats | replayed                             | **not replayed**                         |
| coupons    | can be delivered in-app              | only through an order                    |

A QR visitor typed a phone number that nobody verified, so their session must
not open the history that number owns — otherwise a stranger reads somebody
else's complaints. That is the whole reason the two doors are distinguished.

## `customerId` is trusted, and that is a decision

`customerId` is written to `external_customer_id` and is what a coupon push
sends as the account to credit. The CRM does **not** verify it: it trusts the
caller. That is safe for Yiji because Yiji's own backend makes the call.

A new integrator gets one of two arrangements, decided explicitly:

- **Trusted, like Yiji** — their backend calls this endpoint and asserts the id.
- **Proven** — they send a session token of their own and the CRM resolves the
  id through their API, the way `yijiSessionToken` works today. A forged token
  resolves to nothing and degrades to a walk-in rather than impersonating
  somebody.

Never invent a `customerId`. A caller that does not know one omits it; a
phone-derived handle is written instead, and the coupon path knows that handle
cannot receive an in-app coupon.

## Adding a second app

Three changes, none of them large, and they are deliberately not made in
advance:

1. **`vendors` row** — today the table carries `yiji_vendor_id`. A second
   platform wants `platform` + `external_vendor_id` instead, so a vendor names
   which API it belongs to rather than being assumed.

2. **Coupon endpoint** — `COUPON_ENDPOINTS` in
   `services/workers/src/processors/coupon-push.ts` maps a vendor id to its
   path and platform. One entry today. A second platform is a second entry
   plus its payload builder; the path and the body are declared together
   because a body shaped for one endpoint means nothing to another.

3. **Remove the fallback** — `couponEndpointFor` treats a missing vendor as
   `"1"`, which is correct only while Yiji is the sole platform. With two, an
   unattributed row must fail loudly rather than default to somebody.

`DEFAULT_VENDOR_ID` (socket gateway) does the same thing for sessions and
needs the same treatment at the same time.

## What is already vendor-neutral

The **read** path. `YijiClient` (`packages/shared-types/src/yiji.ts`) is an
interface with a mock and an HTTP implementation, and every method takes a
vendor id as its first argument. Orders, timelines, payment status and tracking
are all behind it. A second platform implements that interface.

The **write** path (coupons) is the one that was Yiji-shaped, and
`COUPON_ENDPOINTS` is the seam that makes it addable rather than rewritable.
