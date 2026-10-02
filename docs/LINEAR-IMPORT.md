# Linear: project and issues, ready to create

Everything below is written to be created as-is. Claude could not create it
directly: `claude mcp list` reports `claude.ai Linear — ✔ Connected`, but that
registration is scoped to the claude.ai web app and exposes no tools to a
Claude Code session. To let Claude file and update these itself:

    claude mcp add --transport http linear https://mcp.linear.app/mcp

Run it in a terminal (not inside a session), complete the browser OAuth, then
restart.

---

## Project

**Name:** Sara CRM — post-go-live
**Summary:** The live CRM for the Yiji food-ordering app. Went live
2026-09-28; work now arrives from the operations team as technical issues and
enhancement requests.
**Team:** Sara CRM

**Labels** (two, deliberately):

- `Technical issue` — something is broken in the live app
- `Enhancement` — something should work better or differently

**States:** Triage → In Progress → Done
**Done means verified on PRODUCTION**, not merged. Those are not the same, and
treating them as the same is how a fix gets reported as shipped while the old
bundle is still being served — which happened on 2026-10-02 and was caught only
by reading the live JavaScript.

**Priorities:** Blocker (live, customers affected) / Normal / Later. Three, not
five.

---

## Issues

Each one below is: title, label, priority, state, description.

---

### 1. Customer sees the closing message as a machine notice

`Technical issue` · Blocker · **In Progress** (fixed, awaiting production)

When a chat is auto-closed after the customer goes idle, the farewell is sent
as a `system` message. The agent portal shows it as "System", which is correct
— the agent needs to know the sweep wrote it and not a colleague. But the
CUSTOMER's widget showed it the same way, so the business's own closing words
read as automated.

The data was never wrong: all ten of these on production carry
`sender_type: 'system'` with null sender fields. The fault was one rendering
line that treated everything-not-agent as the customer.

Fixed: the source decides. A system message that ARRIVED from the server is the
business speaking and renders as a normal incoming message; the widget's own
local notices ("not sent", "nobody online", "file too big") stay grey and are
told apart by a `localNotice` marker, never by their text.

Verified on staging by reading the served bundle (`index-DPOJajqA.js` →
`index-D9IyEZMW.js`, render branch now gated). Commit `a620643`.

---

### 2. A customer writing again was not treated as a new session

`Technical issue` · Blocker · **In Progress** (fixed, awaiting production)

A returning customer correctly keeps their one thread and it reopens with no
agent click. But the first-response PROMISE was never restarted, so every
session after the first was unmeasurable.

Measured on production, conversation `63c22abf`:

    29 Sep 17:50  customer wrote
    29 Sep 17:52  agent replied      -> first_responded_at stamped
     2 Oct 10:16  customer wrote AGAIN
     2 Oct 11:39  agent replied      -> 83 MINUTES later

That chat still reports a two-minute first response and no breach, because the
sweep skips any conversation that already carries a `first_responded_at`.

Fixed: the reopen clears the three first-response fields and stamps
`session_started_at`; the sweep measures from that rather than `date_created`,
which for a reopened chat points weeks into the past and would breach it on
sight. A chat that is still open is untouched — a customer sending three
messages while waiting must not push their own deadline away each time.

Commit `c76993c`.

---

### 3. Push notification failures said nothing about why

`Technical issue` · Normal · **In Progress** (fixed, awaiting production)

`YijiRefusedError` carries Yiji's explanation on `.body`; only `.message` was
logged, and that is always `admin <path> refused (400)`. 630 failure lines over
14 days, none of them actionable — the real reason had to be found by probing
Yiji's live endpoint by hand.

Fixed: the failed-job logger now carries the upstream body, for every queue.
Commit `a620643`.

---

### 4. A permanent push refusal was retried five times

`Technical issue` · Normal · **In Progress** (fixed, awaiting production)

Yiji answers `Customer has no registered FCM device token` for a customer who
never installed the app or denied notifications. That is a fact about a person,
not a transient fault, but it was thrown — so BullMQ retried it five times with
backoff. 126 jobs across 39 conversations in 14 days.

Fixed: known terminal refusals return `unreachable` instead of throwing, and
the verdict is RECORDED on the conversation so an agent can see it — a log line
cannot reach the person waiting for a reply. An unrecognised 400 still throws,
because that is how our own bugs surface. Commit `a620643`.

Context worth keeping: push DOES work — 222 delivered in the same 14 days,
about 64% of attempts.

---

### 5. An agent can start a chat with a customer

`Enhancement` · Normal · **In Progress**

Everything until now assumed the customer speaks first. This is the other
direction: a complaint taken by phone, a promised callback, a check on a late
order.

Done: `POST /chat/agent-initiate` resolves the customer and the thread,
normalising the phone first so a typed `+966…` finds the existing contact
rather than creating a second one, and RESUMING an existing thread rather than
forking. All WeCare roles, agents, supervisors and admins may call it; the
first message is free text. Commits `ba8e386`, `20b2750`.

Not done: the inbox `+` button and compose dialog.

---

### 6. WhatsApp fallback when a customer has no app notifications

`Enhancement` · Normal · **Triage**

About a third of customers cannot receive a push. The agent should be told, in
the thread, with the existing stamped `wa.me` button pre-drafted with a link
back into the CRM chat — so the nudge goes out on WhatsApp and the REPLY lands
in the CRM, keeping the thread intact.

Depends on #4, which is what makes "unreachable" knowable.

---

### 7. Two orphaned probe coupons on Yiji

`Technical issue` · Normal · **Triage**

`73899` (ZZ-PROBE-EEE555) and `73900`, SAR 1 each, single-use, created by a
diagnostic probe on 2026-10-02 and NOT present in the CRM compensation table.
`RemoveCoupon` and `UpdateStatusCoupon` are both 403 for our `agent 1` role, so
only a Yiji admin can remove them.

---

### 8. Schema changes do not reach an environment on deploy

`Technical issue` · Normal · **Triage**

The bootstrap image is BUILT by the pipeline and never run, so a field added in
code is absent from the database after a fully green deploy. That is not
cosmetic: Directus refuses a WHOLE query that names an inaccessible field, so
the SLA sweep's filter 403'd and the sweep silently found nothing — which reads
exactly like "no chats are overdue".

Worked around for this release by POSTing the four fields directly to
`/fields/conversations` on both environments. A full `pnpm apply` is NOT the
fix: it rewrites roles and has twice taken production agent access down.

Worth deciding: either run a fields-only bootstrap step in the pipeline, or make
this a mandatory, written pre-tag check.

---

### 9. Ask Yiji why a third of customers have no FCM token

`Enhancement` · Later · **Triage**

39 distinct conversations in 14 days. Either expected (people decline
notifications) or their app registers for push unreliably. Worth one question
before designing further around it.

---

### 10. Decide whether a cold outbound message needs a template

`Enhancement` · Later · **Triage**

A customer who has not written to us has no context for suddenly hearing from
the brand. Free text was the decision (2026-10-03); quick-pick openers are the
cheap middle ground if inconsistency shows up in practice.
