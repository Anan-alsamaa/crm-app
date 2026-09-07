# Putting the CRM on a custom domain

**Status:** waiting on two people. The Route 53 zone for `crm.anan.sa` EXISTS
(`Z03464742ROS03ROOCX0Q`, created 2026-09-07) and is inert until the parent
zone delegates to it. Everything runs on `*.cloudfront.net` meanwhile, with
valid HTTPS, so this blocks no feature.

---

## What was assumed, and what is actually true

Two beliefs shaped the earlier plan. Both were wrong, and checking them
changed the ask:

**"We already have a `*.anan.sa` certificate."** The live host presents a
Let's Encrypt certificate for **`anan.sa` only** — no wildcard, 90-day, and
not in ACM. It cannot cover `admin.crm.anan.sa`, and importing a 90-day
certificate into ACM means re-importing it by hand four times a year for
ever. CloudFront needs an ACM certificate in **us-east-1**, and ACM's own
certificates renew themselves.

**"`anan.sa` is ours."** It is not in this AWS account and not in Route 53
here. Its DNS is administered elsewhere, which is why a delegation — rather
than a standing request queue — is the shape that works.

---

## Why delegation, and not eight flat hostnames

The first plan was `crm-admin.anan.sa`, `crm-agent.anan.sa` and so on: eight
flat names in someone else's zone. Every one of them needs an ACM validation
CNAME published before its certificate issues, **and again whenever a
certificate is reissued**. That is a standing dependency on another team for
the life of the system.

`crm.anan.sa` delegated to our zone costs them four NS records **once**.
After that every hostname, every validation record and every future change is
ours. The price is one more label in the names, which nobody outside the team
will ever type.

| Host                    | Serves              | Distribution                                                      |
| ----------------------- | ------------------- | ----------------------------------------------------------------- |
| `admin.crm.anan.sa`     | Admin portal        | prod `E37XKA7D2IPZLC`                                             |
| `app.crm.anan.sa`       | Agent portal        | prod `E3UK8T8DHFGMNW`                                             |
| `api.crm.anan.sa`       | Directus + gateways | not created for prod yet                                          |
| `widget.crm.anan.sa`    | Chat + QR pages     | not created for prod yet                                          |
| `*-staging.crm.anan.sa` | the same, staging   | E1VN06BCLZ6Q4F / E24IIVRFOW7GH4 / E2BHUTOA7A1WLB / E2QVORODPLQHNB |

---

## Order of operations

**Production infrastructure is NOT built first.** CloudFront rejects an alias
whose certificate does not already cover it, so a distribution created now
would be created without aliases and updated again afterwards. Nothing is
gained by building early, and the names must be known first.

### 1. Delegation (Dr Abdurrahman) — SENT

Four NS records at `anan.sa`:

```
crm.anan.sa.  NS  ns-1566.awsdns-03.co.uk.
crm.anan.sa.  NS  ns-352.awsdns-44.com.
crm.anan.sa.  NS  ns-584.awsdns-09.net.
crm.anan.sa.  NS  ns-1185.awsdns-20.org.
```

Confirm with `nslookup -type=NS crm.anan.sa 8.8.8.8` — until it answers, the
zone here is invisible to the internet and step 3 cannot validate.

### 2. `acm:RequestCertificate` (Eng. Rabih)

**Not in the current access request** — add it to that thread. Without it we
cannot issue a certificate at all, and `acm:ImportCertificate` is denied too,
so buying one commercially routes around nothing.

### 3. Request the certificate (us, once 1 and 2 land)

```bash
aws acm request-certificate --region us-east-1 \
  --domain-name '*.crm.anan.sa' \
  --subject-alternative-names 'crm.anan.sa' \
  --validation-method DNS
```

**A wildcard covers ONE level.** `*.crm.anan.sa` matches `api.crm.anan.sa`
but not `a.b.crm.anan.sa`, and not `crm.anan.sa` itself — hence the SAN.

Validation CNAMEs go into OUR zone; nobody is asked. Leave them in place for
ever: ACM re-checks them at renewal, and deleting one silently breaks the
renewal a year later.

### 4. Aliases + DNS (us)

Alias and certificate go on the SAME distribution update; CloudFront rejects
an alias with no matching certificate. Then an A-record ALIAS per host.

### 5. Config that is NOT in the portal bundle

- `scripts/gen-portal-config.sh` — the portal URLs. Regenerate and redeploy;
  a config change, not a rebuild.
- `scripts/build-widget.sh` — the widget pages BAKE the API host in at build
  time, so the widget must be rebuilt, not just re-synced.
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
cookie set on `crm.anan.sa` is sent only to that host and below; one set on
`anan.sa` reaches **every** sibling service on the domain. Taking a level of
our own and never configuring the cookie domain at the parent is the
difference between a contained session and one readable by every neighbour.

---

## If it stalls

Nothing is broken. `*.cloudfront.net` has valid HTTPS and every feature
works. In order of preference: ship on CloudFront URLs and switch afterwards
(a config regeneration); or domain the **widget only**, the one URL that
becomes expensive to change.
