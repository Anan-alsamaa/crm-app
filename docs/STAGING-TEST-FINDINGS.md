# Staging test findings — 2026-09-03

First real use of the deployed staging environment by the owner, plus what
testing from this end then turned up. Seven defects.

**Fixed and verified:** the cross-site cookie (1), the Socket.IO target group
(3), the order lookup (4 — now returns the full order), the CloudFront 414 that
emptied every report (7). **Not a bug:** the inbox filters (2), which combine by
design and now say so.

**Also fixed (infrastructure, 2026-09-04):**

| #   | what                                            | effect                                                   | fix                                           |
| --- | ----------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| 10  | Directus cache could not purge on Redis Cluster | **writes appeared not to save** — the real cause of 5, 6 | `CACHE_ENABLED=false`                         |
| 8   | all three service tokens were invalid           | AI config unreadable and unwritable by anyone            | set the accounts' tokens to the deployed ones |
| 9   | the eight AI endpoints had no ALB rule          | every AI feature 404'd, answered by Directus             | listener rules 21 + 22                        |

Defect 10 was the serious one: a write returned 200 with the new value, was
recorded in the audit trail, and the next read still served the old value.

**Current state:** `scripts/test-staging.sh` **17/17** (including the
write-then-read-back check added for defect 10) and
`scripts/sweep-admin-routes.mjs` **22 routes, 0 findings**. A real
`POST /summarize-conversation` returns a generated summary, so the AI path is
alive end to end.

> The lesson worth keeping: neither the suite nor the sweep caught defect 10 at
> first, because **both read back through the same stale cache**. A write test
> must re-read on a SEPARATE request; a 200 proves only that the write was
> accepted.

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

## FIXED — infrastructure, found by sweeping the deployed routes

All three found on 2026-09-04 by `scripts/sweep-admin-routes.mjs`, which drives
all 22 admin routes in a real browser, plus the write/read-back test. None was
code; all three needed an AWS change, and all three would have shipped to
production exactly as they were. All are now fixed and verified.

### 8. All three service tokens were invalid — FIXED 2026-09-04

`SVC_AI_TOKEN`, `SVC_GATEWAY_TOKEN` and `SVC_WORKERS_TOKEN` in the staging task
definitions are all rejected by Directus with **401 INVALID_CREDENTIALS**. The
service accounts exist, are active, and DO hold tokens — the deployed values
simply are not the stored ones. They drifted.

The visible symptom is small and the cause is not:

- `adminRoleIds()` asks Directus which roles are Admin/Administrator using the
  gateway's own token. That call 401s, the `catch` returns an EMPTY SET, and
  the empty set is then cached for five minutes.
- Empty set means `isAdmin` is false for **everybody**, including a real
  Administrator. All four admin-gated AI endpoints answer `403 admin_required`
  — `GET`/`PUT /admin/config` and `GET /admin/usage`.
- So AI settings cannot be read OR changed on staging, by anyone.

> The fallback is deliberately fail-closed, which is right. But it makes a
> credential fault present as an authorization fault, which is what makes this
> expensive to diagnose: the screen says you are not an admin, and you are.

**Fixed.** The deployed values turned out to be the INTENDED ones — they match
`.env.staging` — but were never written onto the Directus accounts, so the two
sides had drifted. Setting each account's `token` to its deployed value fixed
all three with no redeploy of the services.

The AI gateway then still 403'd, because `adminRoleIds()` caches for five
minutes and had cached the empty set. A `--force-new-deployment` cleared it.

Verified: all three tokens authenticate, and `/admin/config` + `/admin/usage`
return **200** with real config.

### 9. The eight AI endpoints had no ALB rule — FIXED 2026-09-04

The listener routes `/commerce/*`, `/admin/config` and `/admin/usage` to the AI
gateway. It does NOT route the eight endpoints in `AI_ENDPOINTS`:

    /summarize-conversation  /suggest-reply     /analyze-sentiment
    /detect-intent           /extract-entities  /semantic-search
    /score-lead              /help-assistant

All eight fall through to the default target and are answered by **Directus**,
which 404s them (`ROUTE_NOT_FOUND`). Verified against all eight.

So every AI feature — Aura, reply suggestions, summaries, sentiment — is dead
on staging, and the 404 comes from the wrong service, so nothing in the AI
gateway's log shows a problem at all.

**Fixed.** Two rules, not one: an ALB allows **5 condition values per rule**
(`condition-values-per-alb-rule`), and two path-pattern conditions on one rule
are ANDed, which would match nothing. So priority 21 carries five paths and 22
carries three, both forwarding to `crm-stg-ai`.

Verified: all eight now reach the gateway, and a real
`POST /summarize-conversation` returns **200 with a generated summary**.

### 10. Directus served STALE data (Redis Cluster) — FIXED 2026-09-04

**The single most serious finding. It explains defects 5 and 6, which I had
attributed to an expired session.**

Reproduced at the API, with no browser involved:

| step                                             | result                                 |
| ------------------------------------------------ | -------------------------------------- |
| `PATCH /items/tickets/<id>` → `status: resolved` | **200**, response body says `resolved` |
| the revision log                                 | the `resolved` write **is recorded**   |
| `GET` the same id, +3s and +8s later             | **`new`**                              |

The write reaches Postgres. The READ does not see it. From the Directus log at
the moment of the write:

    WARN: [cache] ReplyError: CROSSSLOT Keys in request don't hash to the same slot

`REDIS` points at `clustercfg.redis-yiji...` — **cluster mode**. Directus purges
by deleting many keys in ONE command; on a cluster those keys live in different
slots and the multi-key delete is refused. `CACHE_AUTO_PURGE=true` therefore
never actually purges, Directus logs a **WARN and continues**, and every later
read serves the stale entry.

> The severity is in the failure mode, not the error. A write returns 200 with
> the new value in the body, so the API looks correct, the audit trail looks
> correct, and only the next read is wrong. "Mark as solved does nothing" and
> "the approved coupon stays in the pending queue" are both this.

**This is not staging-only.** `CACHE_ENABLED/CACHE_STORE/CACHE_AUTO_PURGE` are
set the same way in `deploy/aws/ecs/directus.json` AND `docker-compose.prod.yml`,
so production inherits it the moment it points at the same cluster-mode Redis.

**Options, cheapest first** — all need approval (AWS write):

1. **`CACHE_ENABLED=false`.** One env var. Correctness immediately; the cost is
   read latency, which on this dataset is single-digit ms.
2. **Point `REDIS` at a non-cluster endpoint.** Keeps caching, needs a
   standalone ElastiCache node.
3. **`CACHE_STORE=memory`.** Caches per task, so two tasks disagree — acceptable
   only at one replica.

**Fixed with option 1** — `CACHE_ENABLED=false`, task definition
`crm-staging-directus:5`, and the same change made in
`deploy/aws/ecs/directus.json` so it cannot ship to production as it was.

`REDIS` and `RATE_LIMITER_STORE=redis` are deliberately KEPT: the rate limiter
issues single-key operations, which a cluster handles normally. Only the
cache's multi-key delete was affected.

Verified: `PATCH` a ticket to `resolved`, immediately re-read → `resolved`.
`scripts/test-staging.sh` is **17/17**, including the read-back check that was
correctly failing before this.

> Note the same trap already bit the socket gateway (ioredis Cluster vs
> standalone). A cluster endpoint is not a drop-in for a standalone one, and
> both failures were silent.

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

**RESOLVED — verified 2026-09-04.** `/commerce/order?vendorId=1&orderId=1234535`
returns **200 with the full order** (status, totals, items, restaurant, delivery)
through CloudFront with a bearer token. The cookie fix was the fix.

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

**Cause: the stale cache — defect 10.** My earlier guess (an expired session
from defect 1) was WRONG, and is recorded here so it is not re-investigated.

The data, the query keys and the polling were all correct, which is exactly why
this was puzzling. The refetch IS issued and DOES succeed — it is answered from
a cache that Directus could not purge, so it returns the pre-decision rows. The
row clears only when the cache entry expires on its own.

Fixing defect 10 fixes this. No application change needed.

### 6. "Mark as solved" does nothing — EXPLAINED by defect 10

**Cause: the stale cache.** The write succeeds (200, recorded in revisions);
the read afterwards serves the pre-write value, so the ticket appears unchanged.

Verified at the API with no browser: `PATCH` to `resolved` returned `resolved`
and was written, and a `GET` 8 seconds later still said `new`.

Fixing defect 10 fixes this. No application change needed.

> I first reported this as "determine whether the request is even sent". It is
> sent, and it works. The request was never the problem.
