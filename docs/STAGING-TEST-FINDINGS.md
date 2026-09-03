# Staging test findings — 2026-09-03

First real use of the deployed staging environment by the owner, plus what
testing from this end then turned up. Seven defects.

**Fixed:** the cross-site cookie (1), the Socket.IO target group (3), the
CloudFront 414 that emptied every report (7). **Not a bug:** the inbox filters
(2), which combine by design and now say so. **Awaiting retest on a fresh
session:** the order lookup (4) and the coupon queue (5), both of which trace
back to defect 1. **Still to reproduce:** mark-as-solved (6) — though the
staging suite now exercises a ticket status write and it passes.

The staging suite (`scripts/test-staging.sh`) is **16/16**.

---

## FIXED — infrastructure and data-scale

### 1. Refresh signs you out

**Cause.** The portals are on `d57v6u4ytjrj7.cloudfront.net` and the API on
`d2vi34f7wgjecb.cloudfront.net` — **unrelated domains**, so every API call is
cross-site. `REFRESH_TOKEN_COOKIE_SAME_SITE=lax` withholds the refresh cookie on
cross-site requests, so the session cannot be restored on reload. It reads as
"it logged me out" rather than as a cookie policy, which is what makes it
expensive to diagnose.

**Fix.** `SameSite=none` (`crm-staging-directus:4`). Safe only because the cookie
is also `Secure` and `httpOnly`, and CORS names the two exact origins.

> This is a **direct consequence of having no custom domain**. With
> `api.crm.yiji-app.com` and `agent.crm.yiji-app.com` the two would be same-site
> and `lax` would work — which is stricter. Revert to `lax` when ACM access
> arrives and proper hostnames are configured.

### 3. Messages stick on "sending"

**Cause.** `socket-gateway` listens on **two** ports:
`httpServer.listen(config.PORT)` carries Socket.IO on **8080**, and
`app.listen({ port: config.PORT + 1 })` carries the REST surface — `/jobs`,
`/webhooks`, `/health` — on **8081**.

The single target group pointed at 8081, so `/socket.io/` reached the REST app,
which has no such route: **404 on every handshake**. The message never leaves the
browser, so the UI sits on "sending" for ever with no error.

**Fix.** A second target group `crm-stg-socketio` on port **8080**,
health-checked on 8081's `/health` via the health-check port override, with
stickiness enabled. Listener rule 10 (`/socket.io`, `/socket.io/*`) forwards
there; rule 11 keeps the REST paths on 8081. Both target groups are attached to
the service.

> Also note `/socket.io/*` alone does **not** match `/socket.io/` — an ALB
> wildcard needs at least one character after it, and the handshake URL is
> exactly that path plus a query string. Both patterns are listed.

### 7. Every report empty — "Could not load report data"

**Cause. HTTP 414 from CloudFront, before any service saw the request.**

The admin ticket breakdown failed whole while **every one of its queries
succeeded when run individually against staging**. The failing one is the query
built FROM another query's output: messages filtered by every conversation id.

A Directus filter travels in the QUERY STRING. 232 conversation ids is a ~9KB
filter that URL-encodes to ~27KB, and CloudFront rejects anything past roughly
8KB — before the ALB, before Directus, so **nothing appears in any service log**.

> This bug **grows into existence**. It cannot reproduce on a dev database with a
> handful of conversations; it appears the day real data pushes the count past
> the limit. It was heading for production identically.

**Fix.** `readChunked` in `@yiji/reports` (120 ids per request), applied to all
six unbounded call sites: the report-exports api (messages, revisions,
conversations, contacts) and both portals' Agent performance pages.

**Verified against deployed staging:** the failing query went from HTTP 414 to
383 messages across two chunks. Staging suite now **16/16**.

---

## OPEN — application behaviour

These reproduce in the UI and need tracing in the code. None is
infrastructure: the requests reach the right service and come back.

### 2. Open / Urgent / Unread filters do not clear — NOT A BUG

The three tiles are **independent filters that combine**, and the state logic
was already correct: clicking Unread then Open legitimately leaves both active.
What was missing was any indication that they stack. A filter summary line and
a Clear link now say so out loud.

> As reported: "clicking Unread then Open leaves both appearing pressed." They
> were pressed because they were both applied. The interface was accurate and
> silent; it is now accurate and explicit.

### 4. Order lookup fails in the CRM, works in Postman

**Cause: the session, again — the same root as defect 1.**

Proved by elimination against the LIVE environment:

| tested                                                      | result                           |
| ----------------------------------------------------------- | -------------------------------- |
| Yiji admin login with `CRMUSER@ANAN.SA` / the real password | **202 Valid Email and Password** |
| `order.yiji-app.com/api/Order/GetOrderAsync/1234535`        | **200, full order**              |
| `/commerce/order` through CloudFront with a session cookie  | **401 Missing bearer token**     |
| ai-gateway logs for any `/commerce/*` request               | **none — only health checks**    |

The request never reaches the gateway. The portal authenticates in **cookie
mode**, so `commerce-client.ts` calls `auth.getToken()` for a bearer token —
and that returns `null` once a refresh has failed. With no header the gateway
rejects the call, and it never appears in its logs.

> **Two things I got wrong while chasing this, recorded so they are not
> re-investigated:**
>
> 1. **`YIJI_ADMIN_PASSWORD=123` is NOT a placeholder** — it is the real
>    password for `CRMUSER@ANAN.SA` and it authenticates successfully. It looks
>    like a dev leftover; it is not.
> 2. **The order is not missing.** It 404s on `admin.yiji-app.com` but returns
>    200 on `order.yiji-app.com`, which is the host the client actually uses
>    (`baseUrl` = `YIJI_API_URL`). `YIJI_API_KEY` being empty is also fine —
>    that API serves this endpoint unauthenticated.

**Secondary defect, fixed.** `commerce-client.ts` caught every non-OK response
identically, so the order panel rendered `No order {{orderId}} for this vendor.`
An auth failure presented as a data failure, which is exactly what sent this
investigation to Yiji and to vendor scoping. A 401/403 now throws
`commerce AUTH`.

**Retest after a fresh sign-in.** The cookie fix should resolve it.

### 5. Approving a coupon leaves it in the pending queue

**The write WORKS.** Checked in the database: the row is `approved` with
`decided_at` set. So this is a display problem, not a lost decision.

My first guess — a stale React Query cache — is **wrong**, and worth recording
so it is not re-investigated:

- `useDecideCoupon` does `invalidateQueries({ queryKey: ['coupon-approvals'] })`
  on success.
- The list uses `['coupon-approvals', status]`, which that prefix correctly
  invalidates.
- The list additionally polls every 30s (`refetchInterval`).

So the data, the keys and the polling are all correct, and the row should clear
within 30 seconds unaided.

**Most likely cause: the session had already expired from defect 1.** The
refetch would then fail silently and the screen would keep showing what it last
had. That fits the report exactly — the toast fires from the mutation's own
success, while the refetch that follows is the part that needs a valid session.

**Retest after the cookie fix before investigating further.** If it still
reproduces on a fresh login, the next step is the network tab: confirm whether
the refetch is issued at all, and what it returns.

### 6. "Mark as solved" does nothing

No visible effect, no error. Determine first whether the request is even sent
(network tab) — that separates a dead handler from a failing call.

---

## Verify each fix against the DEPLOYED environment

Every one of these was invisible until someone used the system. Reproduce in the
browser, not by reading the code, and confirm the fix the same way.
