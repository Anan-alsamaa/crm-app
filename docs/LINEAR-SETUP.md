# Linear: inviting operations, and making it easy to report

Three things the owner asked for (2026-10-03): people with the link can edit,
the activity history is kept and visible, and reporting a new issue is easy.

Everything below is a UI action in Linear. The MCP connector Claude uses can
read and write issues, projects and comments, but **not** members, settings or
templates — so these are yours to do once, and then Claude can work inside them.

Workspace: <https://linear.app/crm-prod>

---

## 1. Letting people edit

**Settings → Administration → Members → Invite**

Invite them as **Member**. A Member can create issues, edit them, comment,
change status and priority — everything operations needs.

Two things worth knowing before you invite:

- **This workspace is on the Free plan, where every member is automatically an
  Admin.** There is no read-only or restricted role on Free. For an internal
  operations team that is usually fine; if you ever need to invite someone
  outside the company, read the next point first.
- **Guest** — access to named teams only, nothing workspace-wide — exists only
  on the **Business plan** (about $8/user/month). That is the role for an
  outside contractor or a vendor.

Free also caps the workspace at **250 issues**. At the current rate — 22 issues
in the first week — that is a long way off, but it is the number that decides
when a paid plan becomes necessary.

---

## 2. The activity history

**Already on, and nothing needs configuring.** Linear records every change on
an issue: who changed what, when, each status move, each edit, every comment.
It is on the issue page under the description, and it cannot be switched off or
edited away. Editing an issue never overwrites the record of what it was.

To have changes _reach you_ rather than waiting to be looked for, pick one:

- **Slack** — Settings → Integrations → Slack, then set team notifications on a
  channel. Every create, status change and comment posts there. This is the one
  to choose if operations already lives in Slack.
- **Email** — on by default for issues you are subscribed to. You are
  subscribed automatically to anything you create or are assigned.
- **Ask Claude** — the connector can read the activity on any issue, so
  "what changed on EMA-18 this week" is answerable on demand.

---

## 3. Making it easy to report

**Settings → Templates → New template**, scoped to the **Emad** team, named
**Report an issue**.

Paste this as the description:

```
**What did you see?**
<!-- What happened, in your own words. One or two sentences is fine. -->

**Where?**
<!-- Admin portal or user portal, and which page. -->

**Which customer, order or ticket?**
<!-- An order number or phone number is the fastest way for us to find it. -->

**What did you expect instead?**
<!-- Only if it is not obvious from the first answer. -->

**Screenshot**
<!-- Drag an image straight into this box. -->
```

Set the template's default **label** to `Technical issue` and its default
**status** to `Backlog` — that is the triage queue.

Then make a second template, **Request a change**, with the same fields but
default label `Enhancement`. Two templates mean the reporter picks the kind of
thing it is at the moment they file it, instead of somebody triaging it later.

Tell the team: press **C** anywhere in Linear to create an issue, pick the
template, fill the blanks. Screenshots paste or drag straight in.

### Why a template rather than training

The detail is what makes an issue fixable. Both of the fixes that shipped
broken in `v1.34.0` were misdiagnosed from a report that was true but thin:

- _"the sunglasses emoji isn't working"_ read as one broken glyph, which
  pointed at fonts. The second report said _"not a single emoji"_ — sixty
  broken glyphs, which points at code. Same bug, and only the second wording
  could find it.
- _"the orders button is blocked"_ read as a permissions problem. It was a
  popup rendered in the wrong tab. _"On clicking, nothing opens"_ and _"the
  button is not there"_ are different reports.

The template asks for what turns the first kind of report into the second.

---

## If reporting should not need a Linear account

**Linear Asks** (file from Slack) and **email intake** (forward to an address,
it becomes an issue) are both **Business plan** features.

Worth the upgrade only if most of the people reporting will never work issues
themselves. If the operations team will also follow their own issues through to
Done, Member accounts plus the templates above cover it at no cost.
