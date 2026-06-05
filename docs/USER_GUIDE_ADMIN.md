# Admin Guide — Yiji CRM Portal

For administrators configuring the platform. The admin portal runs at the URL
your deployment exposes (locally `http://localhost:5174`).

## Signing in

Sign in with an admin account. The portal is role-gated; non-admin accounts are
redirected. Use the language toggle for English / Arabic (RTL).

The first admin is the Directus owner created at bootstrap (the
`DIRECTUS_ADMIN_*` credentials). **Change the default password before going to
production.**

## Users

Create and manage operator accounts.

- **Add a user** — name, email, role (agent / admin), and initial status.
- **Assign to a team** so team-based routing and reporting work.
- Deactivate users who leave; their history is retained.

## Teams

Group agents into teams (e.g. by product line or shift).

- Create a team, add members.
- Conversations and tickets can be assigned to a team rather than an individual,
  and SLA/reporting can be scoped by team.

## Vendors

Vendors are the businesses whose customers you support; each has a stable
`yiji_vendor_id` used by the chat widget.

- Add a vendor with its external `yiji_vendor_id`, display name, and status.
- Only **active** vendors can open widget conversations — the gateway rejects
  tokens for unknown or inactive vendors.
- Set per-vendor **branding colors**; the widget picks these up in its `ready`
  frame.

## SLA policies

Define response and resolution targets.

- Create a policy with **first-response** and **resolution** minutes, the
  priorities it applies to, a warning threshold percent, and optional business
  hours.
- The workers service computes deadlines when a ticket is created/updated, emits
  **warnings** as the deadline approaches and **breaches** when it passes, and
  periodically reconciles open tickets.

## Custom fields

Extend conversations/contacts/tickets with your own fields.

- Define a field (label, type, options) and where it appears.
- Agents then see and fill these fields in the conversation sidebar; they're
  stored on the corresponding Directus record.

## Automation

Author rules that react to events (conversation created, message received,
ticket changes, …).

- Each rule has a trigger, conditions, and actions (e.g. auto-assign, tag,
  notify, change status).
- Rules run in the workers `automation` queue and are **depth-guarded** so a
  rule that triggers another can't loop infinitely.

## Reports

Schedule or run analytics exports.

- Pick a report type. Four are fully implemented: **conversation volume**,
  **response time**, **SLA compliance**, **ticket resolution**. Others render a
  valid "not yet implemented" placeholder so a schedule still fires.
- Apply filters (date range, vendor).
- Add **email recipients** to a schedule and the rendered CSV is emailed when
  the report runs; `last_run_at` is stamped on the report.

## Imports

Bulk-load contacts from CSV.

1. Upload a CSV.
2. **Map** each CSV column to a contact field (name / email / phone /
   external id).
3. Run the import. The worker dedups per vendor on phone or email, creates new
   contacts, flags duplicates, and skips rows with no identifier — then returns
   a per-row summary (created / duplicate / skipped).

## AI configuration

Control the AI features agents see and your spend.

- **Toggle** each AI action (summarize, suggest reply, sentiment, intent,
  entities, semantic search, score lead) on or off. A disabled feature returns a
  clean "disabled by admin" message in the agent panel.
- Set the **monthly cap** on AI usage; the gateway enforces it alongside
  per-user and global rate limits.
- View current **usage** vs the cap.

Outbound prompts are PII-redacted before reaching the AI provider. If no
provider key is configured, AI endpoints return a clean `not_configured` 503 and
agents see "AI provider not configured."

## Operational notes

- Schema, roles, and service tokens are applied idempotently by the Directus
  bootstrap; re-running it is safe and won't duplicate data.
- For deployment, secrets, backups, and scaling, see
  [PRODUCTION.md](./PRODUCTION.md). For the system shape, see
  [ARCHITECTURE.md](./ARCHITECTURE.md).
