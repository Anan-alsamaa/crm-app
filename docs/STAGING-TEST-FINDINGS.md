# Staging test findings — 2026-09-03

First real use of the deployed staging environment by the owner. Six defects.
Two were infrastructure and are fixed; four are application behaviour and need
reproducing against the code.

---

## FIXED — infrastructure

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

---

## OPEN — application behaviour

These reproduce in the UI and need tracing in the code. None is
infrastructure: the requests reach the right service and come back.

### 2. Open / Urgent / Unread filters do not clear

Clicking Unread then Open leaves **both** appearing pressed. Suggests the filter
state is additive where it should be exclusive, or the pressed style is driven
by something other than the active filter.

Start at the inbox filter component in `apps/agent-portal/src/features/inbox`.

### 4. Order lookup fails in the CRM, works in Postman

`No order 1234535 for this vendor.`
(`apps/agent-portal/src/features/commerce/OrderViews.tsx`)

Routing is fine — `/commerce/order` through CloudFront returns **401**, i.e. it
reaches ai-gateway and is properly rejected without auth. `YIJI_API_URL`,
`YIJI_ADMIN_API_URL`, `YIJI_ADMIN_EMAIL` and the password are all set on the
task.

So the difference is most likely the **vendorId** the portal sends versus what
Postman used. `commerce-client.ts` passes `{ vendorId, orderId }`; check where
that vendorId is resolved from and whether staging's data yields the same one.

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
