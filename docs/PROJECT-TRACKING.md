# Project tracking — Sara CRM, post-go-live

The app went live 2026-09-28. Since then the work arrives as technical issues
and enhancement requests from the operations team, verbally and over WhatsApp.
This file is the setup that replaces that, plus the backlog ready to load.

Not a CRM feature. This is how WE run the project.

---

## The tool: Linear

Chosen against the owner's own requirements (2026-10-03):

| requirement                    | Linear                                                   |
| ------------------------------ | -------------------------------------------------------- |
| multiple contributors          | unlimited members; free up to 250 issues                 |
| title + description            | markdown                                                 |
| images                         | paste or drag straight into the description or a comment |
| enhancement vs technical issue | labels                                                   |
| who reported it                | creator and assignee, both first-class                   |
| tracking                       | state, full history, comments, activity log per issue    |

Jira does all of this too and costs weeks of configuration that operations
people then route around. Linear is also visibly a project tool rather than
part of the CRM, which matches what this is for.

### Setup, once

1. Create the workspace at linear.app, invite operations.
2. One team: **Sara CRM**.
3. Two labels, and only two to begin with:
   - `Technical issue` — something is broken in the live app
   - `Enhancement` — something should work better or differently
4. Three states: **Triage → In Progress → Done**.
   "Done" means verified on production, not merged. Those are not the same
   thing, and treating them as the same is how a fix gets reported as shipped
   while the old bundle is still being served — which happened here on
   2026-10-02 and was only caught by reading the live JS.
5. Priority: **Blocker** (live, customers affected) / **Normal** / **Later**.
   Three, not five. A five-point scale becomes two in practice anyway.

### The one rule that matters more than the tool

**One intake path.** An issue that arrives as a voice note is an issue nobody
can count. Operations files it; the owner triages. Everything else is detail.

---

## MCP access from Claude Code

The `claude.ai Linear` connector is CONNECTED but registered under
`Scope: claude.ai config`, which serves the claude.ai web app — its tools are
not exposed to a Claude Code session. To let Claude file and update issues
directly:

    claude mcp add --transport http linear https://mcp.linear.app/mcp

Run it in a terminal (not inside a session), complete the browser OAuth, then
restart. `claude mcp list` should then show a second, non-claude.ai entry.

---

## Backlog, ready to file

Everything below came out of the 2026-10-01 → 2026-10-03 sessions. Labels are
`T` = Technical issue, `E` = Enhancement.

### Blocker

1. **[T] The idle-close farewell reads as a machine notice to the customer**
   The agent portal shows it as "System", which is right — the agent needs to
   know the sweep wrote it and not a colleague. The CUSTOMER's widget shows it
   the same way, which is wrong: to them it is the support team saying goodbye.
   Fixed in `a620643`, verified NOT live on prod by reading the served bundle
   (`index-DaEUcHZi.js` still has the unconditional branch). Awaiting release.

### Normal

2. **[T] Push failures say nothing about why**
   `YijiRefusedError` carries Yiji's reason on `.body`; only `.message` was
   logged, which is always `refused (400)`. 630 failure lines over 14 days,
   none of them actionable. Fixed in `a620643`.

3. **[T] A permanent push refusal is retried five times**
   "Customer has no registered FCM device token" is a fact about a person — no
   app installed, or notifications denied. It was thrown, so BullMQ retried it.
   126 jobs across 39 conversations in 14 days. Fixed in `a620643`; the verdict
   is now recorded on the conversation so an agent can see it.

4. **[E] An agent can start a chat with a customer**
   `POST /chat/agent-initiate` is built (`ba8e386`, `20b2750`). The inbox `+`
   button and compose dialog are NOT — that is the next piece of work.

5. **[E] WhatsApp fallback for a customer with no app notifications**
   About a third of customers cannot receive a push. The agent should be told,
   in the thread, with the existing stamped `wa.me` button pre-drafted with a
   link back into the CRM chat — so the nudge goes out on WhatsApp and the
   REPLY lands in the CRM. Depends on #3.

6. **[T] Two orphaned probe coupons on Yiji**
   `73899` (ZZ-PROBE-EEE555) and `73900`, SAR 1 each, single-use, created by a
   diagnostic probe on 2026-10-02 and NOT in the CRM compensation table.
   `RemoveCoupon` and `UpdateStatusCoupon` are both 403 for our `agent 1` role,
   so only a Yiji admin can remove them.

### Later

7. **[E] Ask Yiji why a third of customers have no FCM token**
   39 distinct conversations in 14 days. Either expected (people decline
   notifications) or their app registers unreliably. Worth one question before
   designing further around it.

8. **[E] Decide whether a cold outbound message needs a template**
   A customer who has not written to us has no context for suddenly hearing
   from the brand. Free text was the owner's call (2026-10-03); quick-pick
   openers are the cheap middle ground if inconsistency shows up.

---

## Open questions for the owner

- Nothing outstanding on roles: all WeCare roles, agents, supervisors and
  admins may start a chat (2026-10-03), and the first message is free text.
