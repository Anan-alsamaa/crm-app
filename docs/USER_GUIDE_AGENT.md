# Agent Guide — Yiji CRM Portal

For support agents working the inbox. The agent portal runs at the URL your
admin gives you (locally `http://localhost:5173`).

## Signing in

1. Open the portal URL. You'll land on the sign-in page.
2. Enter the email and password your admin created for you.
3. You'll be taken to the **Inbox**. Access is role-gated — if you see a
   "not authorized" screen, your account isn't an agent role; ask your admin.

Use the language toggle (top bar) to switch between English and Arabic; the
layout flips to right-to-left for Arabic automatically.

## Working the inbox

The inbox is the list of conversations on the left. Each row shows the contact,
a preview, priority, unread count, and tags.

- **Filter** by status (open / pending / closed / all) and priority, and
  **sort** by most recent, oldest, or priority.
- **Search** by contact name, email, or phone.
- The list updates in **realtime** — new customer messages bump a conversation
  and raise its unread badge without a refresh (`inbox:activity`).

Click a conversation to open it.

## In a conversation

The conversation view has the message thread in the middle, a composer at the
bottom, and a details sidebar on the right.

### Replying

- Type in the composer and send. Your reply is delivered to the customer
  instantly and appears in the thread.
- **Typing indicators** and **read receipts** flow both ways in realtime.
- Messages persist through the gateway — if a send fails you'll see an inline
  error rather than a silent drop.

### Internal notes

- Switch the composer to **note** mode to leave an internal note. Notes are
  visible to agents only — the customer never sees them.
- **@mention** a teammate in a note to notify them (they get an in-app
  notification, and an email if their preferences allow). Mentions are parsed
  from the note text.
- You can delete your own notes; the system refuses to delete a real
  customer/agent message even if a note id is crafted, so notes stay safe.

### Changing conversation state

From the sidebar / toolbar you can:

- **Assign** the conversation to yourself, another agent, or a team.
- Change **status** (open → pending → closed) and **priority**.
- Add **tags** (pick existing or create a new one).
- Fill in **custom fields** your admin defined for conversations.

Changes propagate to other agents in realtime: peers viewing the same thread
get a refresh signal, and everyone's inbox list updates.

### Linked tickets

The sidebar lists tickets linked to the conversation. You can open the
**Create ticket** dialog to raise a ticket from the conversation; SLA timers
start automatically based on the matching policy.

## The AI panel

The sidebar's **AI assistance** panel offers per-conversation actions
(availability depends on what your admin enabled):

- **Summarize** — a short summary of the thread.
- **Suggest reply** — drafts a reply (optionally seeded from your draft and
  locale); click to paste it into the composer, then edit before sending.
- **Sentiment**, **Intent**, **Entities** — quick analysis of the conversation.
- **Score lead** — a 0–100 lead score with signals.

Customer PII is redacted before anything is sent to the AI provider. If a
feature is turned off, over the monthly budget, or rate-limited, the panel tells
you in plain language instead of failing silently.

## Contacts

The **Contacts** area lists customers. Open a contact to see their profile,
conversation history, and (where available) a commerce panel with their orders/
context pulled from the Yiji platform.

## Notifications

The bell in the top bar shows in-app notifications (mentions, assignments, SLA
warnings). Open **Preferences** to control which notification types you receive
in-app vs by email.

## Tips

- Everything realtime (messages, presence, inbox activity) works without
  refreshing — if something looks stale, your socket may have dropped; reload.
- The command palette (keyboard shortcut shown in the UI) jumps between common
  actions quickly.
