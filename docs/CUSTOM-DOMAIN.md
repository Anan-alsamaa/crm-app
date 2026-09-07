# Putting the CRM on a custom domain

**Status:** eight hostnames requested from the team that administers
`anan.sa`. Everything runs on `*.cloudfront.net` meanwhile, with valid
HTTPS, so this blocks no feature.

---

## What was assumed, and what is actually true

**"We already have a `*.anan.sa` certificate."** No. The live host presents a
Let's Encrypt certificate for **`anan.sa` alone** — no wildcard, 90-day, not
in ACM.

**But that does not matter, because `anan.sa` is on Cloudflare.** Its
nameservers are `salvador.ns.cloudflare.com` and `elma.ns.cloudflare.com`.
When a hostname is created there as **proxied** (Cloudflare's default,
the orange cloud), Cloudflare terminates TLS and issues and renews the
certificate itself. So:

- no ACM certificate is needed for the portals and the API;
- **`acm:RequestCertificate` is NOT a blocker** — it was only required for
  the ACM route, and is not on the critical path;
- no validation records, now or at renewal.

A delegated `crm.anan.sa` zone was created and then **deleted** on 2026-09-07.
It solved a problem that does not exist here: its only real benefit was
avoiding repeat requests for ACM validation records, and the team already
issues subdomains freely at no cost. Asking for NS delegation would have
been an unfamiliar mechanism in exchange for nothing.

---

## The eight hostnames

Each is a CNAME to the distribution that serves it.

| Hostname                     | Serves              | Target                            |
| ---------------------------- | ------------------- | --------------------------------- |
| `crm-admin.anan.sa`          | Admin portal        | `d3sw1ca3dpsao0.cloudfront.net`   |
| `crm-agent.anan.sa`          | Agent portal        | `d1feea9xuruu0v.cloudfront.net`   |
| `crm-api.anan.sa`            | Directus + gateways | prod distribution not yet created |
| `crm-widget.anan.sa`         | Chat + QR pages     | prod distribution not yet created |
| `crm-admin-staging.anan.sa`  | Admin portal        | `d1evkiaehtmzr0.cloudfront.net`   |
| `crm-agent-staging.anan.sa`  | Agent portal        | `d57v6u4ytjrj7.cloudfront.net`    |
| `crm-api-staging.anan.sa`    | Directus + gateways | `d2vi34f7wgjecb.cloudfront.net`   |
| `crm-widget-staging.anan.sa` | Chat + QR pages     | `dk7gqau5j3o4b.cloudfront.net`    |

The two production distributions that do not exist yet are created when
production is built; their targets follow.

---

## Order of operations

**Production infrastructure is NOT built first.** A CloudFront distribution
rejects an alias whose certificate does not cover it, so anything created
before the names are known would be created without aliases and updated
again afterwards. Nothing is gained by building early.

### 1. The hostnames (the `anan.sa` administrator)

Eight CNAMEs, as above. **Proxied** so Cloudflare issues the certificate.
Verify each with `nslookup <host>` before touching the distribution.

### 2. Aliases on the distributions (us)

Only needed for hosts NOT proxied by Cloudflare. A proxied hostname reaches
CloudFront through Cloudflare, which presents its own certificate to the
visitor; CloudFront still needs the alias to accept the Host header, and an
alias requires a matching certificate — so **if a host is proxied, confirm
end to end before assuming it works**, and fall back to ACM (step 3) for any
host that does not.

### 3. ACM, only if a host cannot be proxied

Needs `acm:RequestCertificate` in **us-east-1**, currently denied. A wildcard
covers ONE level: `*.anan.sa` matches `crm-admin.anan.sa` but not
`a.b.anan.sa`.

### 4. Config that is NOT in the portal bundle

- `scripts/gen-portal-config.sh` — the portal URLs. Regenerate and redeploy;
  a config change, not a rebuild.
- `scripts/build-widget.sh` — the widget pages BAKE the API host in at build
  time, so the widget must be REBUILT, not just re-synced.
- **`PUBLIC_URL`** on Directus — password-reset and invitation emails are
  built from it and keep pointing at CloudFront otherwise.
- **CORS** — `CORS_ORIGIN` and `WIDGET_CORS_ORIGIN` on the gateway.

---

## Why the widget hostname matters most

The portals are internal; staff tolerate an ugly URL. The widget is embedded
in customer pages as a `<script src>`:

```
https://dk7gqau5j3o4b.cloudfront.net/yiji-chat-widget.js
```

Once restaurants paste that in, changing it means chasing every one of them.
**Pin this one before go-live**, even if the portals stay on CloudFront URLs.

---

## Cookie scope

Directus sets its refresh cookie with `REFRESH_TOKEN_COOKIE_SECURE=true`. A
cookie set on `crm-admin.anan.sa` is sent only to that host; one set on
`anan.sa` reaches **every** sibling service on the domain. Never configure
the cookie domain at the parent — on a domain shared with other teams that is
the difference between a contained session and one readable by every
neighbour.

---

## If it stalls

Nothing is broken. `*.cloudfront.net` has valid HTTPS and every feature
works. In order of preference: ship on CloudFront URLs and switch afterwards
(a config regeneration); or domain the **widget only**, the one URL that
becomes expensive to change.
