# How to test the CRM before go-live

**Written 2026-09-07.** Every URL and account below was verified working on
that date. Test **staging** first — it holds 1,692 real imported tickets, so
the reports and dashboards have something to show. Production is empty by
design and is for proving the plumbing, not for exploring features.

---

## URLs

### Staging — use this for feature testing

| What          | URL                                          |
| ------------- | -------------------------------------------- |
| Admin portal  | https://d1evkiaehtmzr0.cloudfront.net        |
| Agent portal  | https://d57v6u4ytjrj7.cloudfront.net         |
| Customer chat | https://dk7gqau5j3o4b.cloudfront.net         |
| Store QR page | https://dk7gqau5j3o4b.cloudfront.net/walk-in |
| API           | https://d2vi34f7wgjecb.cloudfront.net        |

### Production — plumbing only, keep it clean

| What          | URL                                          |
| ------------- | -------------------------------------------- |
| Admin portal  | https://d3sw1ca3dpsao0.cloudfront.net        |
| Agent portal  | https://d1feea9xuruu0v.cloudfront.net        |
| Customer chat | https://d6ww6tccn45er.cloudfront.net         |
| Store QR page | https://d6ww6tccn45er.cloudfront.net/walk-in |
| API           | https://d2ljjkmk6p5y4b.cloudfront.net        |

---

## Accounts

### Staging

| Role               | Email                         | Password   |
| ------------------ | ----------------------------- | ---------- |
| WeCare Admin       | `a.dawoud@anan.sa`            | `12345678` |
| WeCare Supervisor  | `test.supervisor@example.com` | `123456`   |
| WeCare Agent       | `e2e.agent@example.com`       | `123456`   |
| Department Manager | `test.manager@example.com`    | `123456`   |
| Operations         | `test.ops@example.com`        | `123456`   |
| Administrator      | `e.habibi@anan.sa`            | in `.env`  |

### Production

Only the owner account exists (`e.habibi@anan.sa`, password in
`.env.prod.aws`). **Staff accounts have not been created** — that decision is
the owner's. The nine roles are in place and ready to assign.

---

## Test phone numbers

Any `05` number works; nothing is verified. Use a number nobody owns, and say
so in the chat so a real agent is not misled:

```
0500000001   0500000002   0500000003
```

Anything typed in the chat is stored and visible to agents. Do not use a real
customer's number on either environment.

---

## The tests that matter most

Ordered by consequence, not by convenience. If time is short, do 1–4.

### 1. A customer conversation, end to end

The core of the product, and the one thing that must work.

1. Open the customer chat URL. It should redirect to `/walk-in` and appear
   **in Arabic** unless your browser asks for English.
2. Type `0500000001`. The field is prefilled `05` — typing your full number
   over it is handled correctly.
3. Send a message.
4. In another browser (or a private window) sign in to the **agent portal**.
5. The conversation should appear in the inbox within seconds.
6. Open it, reply, and confirm the reply reaches the customer window.

**What is being proved:** the widget, the gateway, the socket, the database
and the agent portal are all connected. This is the test that catches the most.

### 2. The same customer comes back

1. In the customer window, reload the page.
2. It returns to the phone form — the session token is used once, on purpose.
3. Enter the **same** number.
4. The earlier conversation should reappear, with its history.

**What is being proved:** a returning customer is not given a second thread.
Duplicated conversations were a real defect; this is the check for it.

### 3. Ticket, SLA and history

1. In the agent portal, open a conversation and choose **Add ticket**.
2. Pick a ticket type, add a description, create it.
3. The ticket page should open. Check the SLA countdown appears.
4. Press **Mark as solved**, then reload the page — the status must survive.

**What is being proved:** tickets persist, SLA timers run (first response 5
minutes for chat, 30 for tickets; resolution 8 hours), and state is stored
rather than only shown.

### 4. Branch attribution

1. Admin portal → **Ticket breakdown**.
2. Confirm rows show a branch and its brand, not "Not mapped".
3. Set the date range to something covering the imported data.

**What is being proved:** all 133 stores resolve. A ticket attributed to
nothing cannot be reported on or escalated to the right manager.

### 5. Roles see the right things

Sign in as each of the staging accounts and confirm the differences:

- **WeCare Agent** — inbox and tickets, no admin settings
- **WeCare Supervisor** — the above plus approvals and team views
- **WeCare Admin** — users, roles, reports, configuration
- **Operations** — dashboards and exports, nothing else
- **Department Manager** — their department's tickets

**What is being proved:** the nine roles carry 563 permissions between them,
copied from staging to production. A role granting too much is invisible
until it matters.

### 6. Arabic throughout

Switch language in the portal, and open the customer chat with an Arabic
browser. Check that the layout flips right-to-left and nothing is clipped
or left in English.

### 7. Reports and exports

Admin portal → Reports. Run each one, change the date range, export a CSV.
Staging has 1,692 tickets so these have real content; production will be
empty until it is used.

---

## Known and deliberate

Not faults — these are decisions, so that a tester does not report them:

- **Production is empty.** No tickets, contacts or conversations. It has
  never carried traffic.
- **Coupon delivery is ON in production** (owner's decision, 2026-09-08). An
  approved coupon reaches a real customer. Do not approve one to "see what
  happens".
- **The `anan.sa` hostnames do not resolve yet**, so everything is on
  CloudFront URLs. Waiting on the DNS request — this is the only thing still
  outstanding before go-live.
- **Alarms reach e.habibi@anan.sa.** Eleven production alarms, confirmed
  subscription. Staging has none on purpose: a test environment that pages you
  teaches you to ignore the alerts.
- **Staging holds 81 teams named "QA Team …"** — test residue, deliberately
  not copied to production.

---

## What to report, and how

For anything unexpected, the useful details are:

- Which **environment** (staging or production) and which URL
- Which **account** you were signed in as
- What you did, what you expected, what happened
- The **time**, so it can be found in the logs
- A screenshot if it is visual

Console errors (F12 → Console) are worth including if the page misbehaved.

---

## After testing

Delete any conversations and contacts your testing created, especially on
production — it should return to zero contacts and zero conversations before
real customers arrive. The scripts in `scripts/` can do this, or an admin can
delete them through the portal.
