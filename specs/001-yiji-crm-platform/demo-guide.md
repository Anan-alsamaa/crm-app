# Yiji CRM — Team Demo Guide

**Audience:** mixed (business + engineers). Lead with the workflow, close with a short "how it works."
**Spine:** the **core support flow** — a customer messages from the widget, an agent handles it in real time, resolves it, and the customer rates it.

> Total runtime: ~12–15 min for the core flow, +5 min for the architecture section.

---

## 0. Before the demo (do this 15 min early)

**Free RAM first.** This box is memory-tight; close anything you don't need (extra VS Code windows, spare browser tabs). A mid-demo OOM is the only real risk.

**Start the backend, then the portals:**
```bash
# 1. Backend (wait ~30s for "directus healthy")
cd crm-app-infra && docker compose up -d

# 2. Portals
cd ../crm-app-frontend && pnpm --filter "@yiji/agent-portal" --filter "@yiji/admin-portal" --filter "@yiji/chat-widget" --parallel dev
```

**Confirm everything is up:**
- Backend: `docker compose ps` → 6 containers healthy
- Widget: http://localhost:5175 • Agent portal: http://localhost:5173 • Admin portal: http://localhost:5174 • Directus: http://localhost:8055

**Logins / demo identities:**
| Who | Where | Credentials |
|---|---|---|
| Support agent | Agent portal :5173 | `e2e.agent@example.com` / `E2eAgentPass1!` |
| Administrator | Admin portal :5174 | `e.habibi@anan.sa` / `123456` |
| Customer | Widget :5175 | auto — the dev page signs a token for **"Demo Customer"** (vendor `demo-vendor`) |

**Open these tabs in advance** (so you can switch fast on screen): agent portal (logged in, on the Inbox), the widget page, and the admin portal (logged in).

**If AI features are in scope:** confirm `GEMINI_API_KEY` is set in the root `.env` (the AI panel needs it). If not set, skip the AI step or it'll show a graceful "unavailable."

---

## 1. CORE SUPPORT FLOW (the headline — run this first)

### Step 1 — Customer starts a chat (widget, :5175)
- Open the widget tab. Click the launcher → the chat panel opens, **branded with the vendor's colors/logo**, greeting the customer by name ("Welcome back, Demo Customer" for a returning customer).
- Type a message, e.g. *"Hi, my order #4821 hasn't shipped yet — can you check?"* and send. Optionally attach an image to show **file attachments**.
- 🗣️ *Say:* "The customer never creates an account — the Yiji platform passes a signed token, so we already know who they are and which vendor they belong to."

### Step 2 — It lands in the agent's inbox in real time (agent portal, :5173)
- Switch to the agent portal **without refreshing**. The new conversation appears at the top of the shared inbox with an **unread badge** — pushed live, no reload.
- 🗣️ *Say:* "Every agent's inbox updates the instant a customer sends anything — that's the realtime gateway."

### Step 3 — Agent opens the conversation
- Click it. Show:
  - The **full message history** + the customer's message.
  - The **customer profile + commerce panel** on the side — lifetime value, recent orders, payment/shipment status (pulled from the Yiji platform).
  - **Typing indicator** + **online presence**.
- 🗣️ *Say:* "The agent has commercial context next to the conversation — no swivel-chair between systems."

### Step 4 — AI assist *(optional, if Gemini key is set)*
- Open the **AI panel**: click **Summarize** (condenses the thread) and **Suggest reply** (drafts a response). Optionally show **sentiment**.
- 🗣️ *Say:* "Before anything leaves our system, PII — emails, phones, payment refs — is redacted. The AI never sees raw customer data."

### Step 5 — Agent replies (realtime round-trip)
- Type a reply and send. **Switch to the widget tab** — the customer sees the reply appear live, with the agent's typing indicator beforehand.
- 🗣️ *Say:* "Sub-second round-trip, both directions, over the same realtime channel."

### Step 6 — Triage: assign + status
- Back in the agent portal toolbar: **assign the conversation** to the agent, set **priority**, add an **internal note** (with an `@mention` — visible to agents only, never the customer), apply a **tag**.
- Move status **open → resolved**.
- 🗣️ *Say:* "Notes and mentions are internal-only; the customer never sees them."

### Step 7 — Customer rates it (CSAT)
- In the widget, when the conversation is closed the customer gets a **CSAT survey** — submit a rating.
- 🗣️ *Say:* "That score flows straight into reporting — one rating per conversation."

✅ **That's the heartbeat of the product.** Everything else supports this loop.

---

## 2. SUPPORTING WORKFLOWS (show briefly, 1–2 min each)

**Tickets + SLA** — From a conversation, **create a ticket**. Show the ticket lifecycle (`new → open → pending → resolved → closed`), the **SLA due dates**, and that a breach fires a **notification** + escalation. Point out the **append-only history** (tamper-evident audit trail).

**Admin configuration (:5174)** — As admin, show: **Users & Teams**, **SLA policies**, **Automation rules** (auto-assign, escalation on keywords, VIP routing), **AI config** (toggle features per vendor + monthly cap). Emphasize: *admins configure everything without superuser/database access.*

**Reporting** — The **dashboard** (conversation volume, avg response time, SLA compliance, CSAT, agent productivity) + **scheduled reports** with CSV export.

---

## 3. HOW IT WORKS (3–4 min — for the engineers)

```
Customer (signed JWT)
   │  widget (Preact)
   ▼
socket-gateway (Socket.IO + Redis Pub/Sub adapter)  ── realtime, horizontally scalable
   │  service token
   ▼
Directus (system of record on PostgreSQL)  ── CRUD + auth + RBAC (policies/permissions)
   ▲                         │
   │ service tokens          ▼
ai-gateway (Gemini,        workers (BullMQ on Redis)
 PII redacted)              SLA · notifications · automation · imports · scheduled reports
```

Key points to land:
- **One realtime gateway, built to scale** — the Redis adapter means you run N gateway instances and broadcasts still reach every agent. (We load-tested 100 concurrent customers: 100% delivery, every message fanned out to all agents.)
- **Directus is the single source of truth** — every message/ticket/conversation is persisted and queryable; roles & permissions are Directus-native (no separate auth service). The only custom auth is the customer's signed widget JWT (customers aren't CRM users).
- **Async work is queued** — SLA timers, notifications, automation, imports, and scheduled reports run on BullMQ workers, off the realtime hot path.
- **AI is isolated + safe** — a dedicated gateway redacts PII before any Gemini call; the provider is swappable.
- **Stack:** pnpm monorepo, TypeScript strict, React 18 + Vite portals, Preact widget, Tailwind, EN/AR with RTL.

---

## 4. If something breaks live (recovery cheatsheet)

| Symptom | Fix |
|---|---|
| Widget/agent "offline", messages not flowing | Backend likely down. `cd crm-app-infra && docker compose ps` → if unhealthy: `docker compose up -d` |
| Docker engine itself down (`npipe` error) | `Restart-Service com.docker.service -Force`, wait ~30s, then `docker compose up -d` |
| A portal not loading (5173/4/5) | Restart dev servers: `pnpm --filter … --parallel dev` (see §0) |
| AI panel shows "unavailable" | `GEMINI_API_KEY` not set — skip that step; everything else is independent |
| Everything sluggish / a crash | RAM pressure — close other apps; the stack alone is fine, it's the box that's tight |

**Golden rule:** have the backend + portals confirmed-up 15 min before, on a machine with RAM headroom. The product is solid; the only fragility is this dev box's memory.
