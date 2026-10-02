# Agent-initiated chat + the push fallback ladder

Owner's ask (2026-10-02): an agent should be able to start a chat with a
customer from the inbox — a `+` button, type a phone number, send a message —
and the customer learns about it through the notification API we already have.

Everything happens on STAGING until the owner double-confirms a prod release.

---

## What was MEASURED before any code was written

Push notification **works**. Production, 14 days, log-derived and unpaged:

|                                 | count   |
| ------------------------------- | ------- |
| delivered                       | **222** |
| failure log lines               | 630     |
| distinct failing jobs           | **126** |
| distinct conversations affected | 39      |

Roughly **64% of attempts succeed**. (An earlier "0 delivered" reading of mine
was wrong: `--max-items 400` truncated a 3-day window that held 392 failure
lines, so the page size was mistaken for a measurement. Count unpaged, or
filter for the success string directly.)

**Yiji's actual refusal**, probed live against a deliberately non-existent
number (`+966500000000`), so no real handset was touched:

    POST https://notificationsystems.yiji-app.com/api/NotificationData/SendCrmNotification
    -> 400 {"result":2,"exceptionMessage":"Customer has no registered FCM device token."}

and with an empty body:

    -> 400 {"result":2,"exceptionMessage":"Either UserId or PhoneNumber must be provided."}

So the payload we send today is **correct and accepted**. The 400 means _this
customer's handset has no push token_ — they never installed the Yiji app, or
denied notifications. That is a **permanent per-customer fact**, not a
transient fault.

### The three faults that follow from it

1. **The reason never reaches the logs.** `YijiRefusedError` carries Yiji's
   explanation in `.body` (`yiji-impl.ts:601-610`), but the worker's log line
   prints only `err` — the message — so "no FCM device token" has been
   invisible for the whole life of the feature. It took a live probe to learn
   it. This is the [[silent-empty-failures]] shape again: a real, knowable
   cause rendered as an opaque status code.
2. **A permanent condition is retried.** The worker throws, so BullMQ retries
   5x with backoff: 630 log lines from 126 jobs, and ~5 wasted calls to Yiji
   per unreachable customer. No amount of backoff grows an FCM token.
3. **About a third of customers cannot be reached this way** — which is the
   real constraint on the new feature, not a bug to fix.

---

## Why the fallback is a LADDER, not a choice

Push and WhatsApp are different mechanisms, not competing options:

|              | push (`SendCrmNotification`)             | WhatsApp (`wa.me`)             |
| ------------ | ---------------------------------------- | ------------------------------ |
| reaches      | ~64% (measured)                          | near-universal in Saudi        |
| agent effort | zero, automatic                          | manual: click, tab, type, send |
| lands        | inside the Yiji app, taps into THIS chat | a separate WhatsApp thread     |
| record       | job log                                  | audit stamp (already built)    |

The asymmetry that decides it: **push brings the customer back into the CRM
chat; WhatsApp pulls the conversation out of it.** Defaulting to WhatsApp would
move support conversations into a channel the CRM cannot see, measure for SLA
or report on — quietly undoing the one-chat-surface work.

So: push fires automatically; only a _known_ "no FCM token" refusal surfaces
the WhatsApp fallback to the agent, pre-drafted with a link back into the CRM
chat, so the nudge goes out on WhatsApp and the REPLY lands in the CRM.

No new WhatsApp infrastructure: `whatsappNumber()` (`phone.ts:129`) and the
stamped link builder (`features/tickets/whatsapp.ts:85`) already exist.

---

## Progress

| #   | task                                         | state              |
| --- | -------------------------------------------- | ------------------ |
| 1   | carry Yiji's refusal reason into the log     | **done** `a620643` |
| 2   | stop retrying a permanent refusal; record it | **done** `a620643` |
| 3   | `initiated_by` + SLA sweep exclusion         | **done** `a620643` |
| 3b  | farewell reads as the agent in the WIDGET    | **done** `a620643` |
| 4   | gateway `POST /chat/agent-initiate`          | **done**           |
| 5   | inbox `+` button and compose dialog          | next               |
| 6   | unreachable notice + WhatsApp fallback       |                    |
| 7   | permissions                                  |                    |
| 8   | staging deploy + real-handset proof          |                    |
| 9   | production, on double confirmation           |                    |

Tasks 1-3 are verified: 60/60 worker push tests, 12/12 rendering tests,
typechecks clean on workers, chat-widget, shared-types and bootstrap.
NOT yet deployed anywhere.

## The sequence

Each task is independently shippable and verified before the next begins.
Tasks 1-2 are the diagnosability fix the feature depends on; 3-7 are the
feature; 8-9 are release.

### 1. Carry Yiji's refusal reason into the log

`customer-push` logs `err.message` only. Log `err.body` too (it is already on
the error object), so CloudWatch shows _why_ a push was refused.

- Touches: `services/workers/src/processors/index.ts` (the catch/log site).
- Test: a refusal with a body logs the body.
- Verify: after deploy, a real refusal shows `Customer has no registered FCM
device token.` in `/ecs/crm-staging/workers`.

### 2. Stop retrying a permanent refusal; record it on the conversation

"No FCM device token" and "Customer not found" are terminal. Return a new
`unreachable` outcome instead of throwing, and persist it so the UI can read
it — a log line cannot reach an agent's screen.

- New field `conversations.push_unreachable_at` (dateTime, nullable) + a
  `push_unreachable_reason` string. Staging bootstrap first.
- Classify by Yiji's `exceptionMessage`, not by status code: a 400 is also how
  a malformed payload fails, and that one SHOULD retry.
- Test: terminal reason -> `unreachable`, no throw; an unknown 400 still
  throws so BullMQ retries.

### 3. `initiated_by` on conversations

A chat the agent started is a different object from one the customer opened:
it has no customer first message, so first-response SLA must not measure it as
an unanswered inbound.

- New field `conversations.initiated_by` ('customer' | 'agent', default
  'customer').
- Audit the SLA sweep and the KPI reports for what this changes before
  writing it — an agent-initiated chat with no customer message would
  otherwise read as a breach.

### 4. Gateway endpoint: start a conversation as an agent

`POST /chat/agent-initiate` — authenticated as an AGENT (not a customer
session), takes a phone number and the first message.

- Normalise to canonical `05XXXXXXXX` (`phone.ts`) BEFORE lookup; a
  non-canonical number creates a duplicate contact.
- Find-or-create the contact, reusing the existing upsert path
  (`socket-gateway/src/directus.ts:150-250`) rather than a second
  implementation — it already handles the walk-in -> app promotion.
- **Resume, do not duplicate**: an open OR solved conversation for this
  contact must be reused ([[chat-resume-one-per-contact]]).
- Write the message as `sender_type: 'agent'`, assign to the initiating agent,
  then enqueue `customer-push`.
- Reject a number that is not a valid Saudi mobile, with a reason the UI can
  show.

### 5. Inbox `+` button and the compose dialog

In the inbox, beside the conversation list.

- Phone input -> on blur, show whether this is a known contact (name) or a new
  one, so the agent knows who they are about to message.
- Message textarea, send button, inline errors.
- On success: open the conversation in the thread pane — same page, no
  navigation away.
- Follows DESIGN.md (AURA LIGHT, centred pill top-nav; no sidebar).

### 6. Surface the unreachable notice + WhatsApp fallback

When `push_unreachable_at` is set on a conversation the agent started, show it
in the thread: "this customer cannot receive app notifications", with the
existing WhatsApp button pre-drafted with a link back to the CRM chat.

- Reuse `features/tickets/whatsapp.ts`, including its audit stamp.
- Must not appear on a conversation the CUSTOMER started — they are already
  looking at it.

### 7. Permissions

Which roles may start a chat. Follows the mandated model
([[roles-model-owner-tier]]): a privilege, materialised on the role rows,
**counted before and after** ([[contacts-create-privilege-gap]] — a code
change alone does not apply it).

Also gate the endpoint, not just the button: hiding is not securing.

### 8. Staging: deploy, then prove it with a real handset

- `pnpm verify` (9 gates) + the new tests. Note `pnpm verify` does NOT run
  Playwright.
- Staging redirects every push to the test handset, keyed on the DIRECTUS HOST,
  never `NODE_ENV` ([[staging-test-redirects]]) — confirm the new path honours
  it, or an agent-initiated test message rings a real stranger.
- Prove: a push ARRIVES on the test handset, the tap opens the CRM chat, the
  customer's reply lands in the same conversation.
- Prove the unhappy path too: a number with no FCM token shows the notice and
  does not retry 5x.

### 9. Production — only on the owner's double confirmation

A `v*` tag IS the prod release ([[live-staging-first-rule]]). Agent portal and
chat widget park behind "Update now"; the admin portal is never gated.
Digest-verify 4/4 against the ECR tag — a COMPLETED rollout is not proof.

---

## Open questions for the owner

- **Who may start a chat?** All agents, or supervisors and above only? An
  outbound message to a customer is a different kind of act from answering one.
- **Is there a template?** A cold message from a brand usually needs an opening
  line ("This is Yiji Support about your order ..."), and a free-text box
  invites inconsistency.
- Worth asking Yiji whether the ~36% without an FCM token is expected, or
  whether their app build registers for push unreliably. 39 distinct
  conversations in 14 days is enough to be worth a question.

---

## STAGING VERIFICATION, 2026-10-03

CI green (3/3, Playwright included). Staging deploy green (4/4 services).

**Proved on staging, not assumed:**

| check                                   | before                         | after                                         |
| --------------------------------------- | ------------------------------ | --------------------------------------------- |
| widget bundle                           | `index-DPOJajqA.js`            | `index-D9IyEZMW.js`                           |
| `send-failed` / `attach-failed` markers | absent                         | present                                       |
| render branch                           | `system ? 'system' : 'theirs'` | `system && localNotice ? 'system' : 'theirs'` |
| `POST /chat/agent-initiate`             | 404                            | 401 (no token) / 403 (junk token)             |

Functional, as a real Administrator:

- a chat was CREATED for `0500000288`, `initiated_by = 'agent'`
- the same number again RESUMED it (`created: false`, same conversation id)
- `+966500000288` normalised to `0500000288` and found the SAME contact — no
  duplicate
- `external_customer_id` stayed EMPTY: a typed number is not a proven Yiji
  account
- the agent-initiated chat is EXCLUDED from the first-response sweep (count 0)

Test conversations and contacts were deleted afterwards.

## THE TRAP THIS RELEASE FOUND — read before the next schema change

**The three new fields were MISSING from staging after a fully green deploy.**
The bootstrap image is built by the pipeline and never run; schema reaches an
environment only through a manual apply.

That is not a harmless gap, because **Directus 403s a whole query that names an
inaccessible field** — it does not ignore the term. The first-response sweep's
own filter was therefore failing completely:

    with `filter[initiated_by][_neq]=agent`   -> ERROR 403
    without it (the old filter)               -> 150 conversations

So the sweep silently found nothing, which reads exactly like "no chats are
overdue". `docs/RELEASE.md` warns about this in one line — _"bootstrap first,
then the new images. A new column the old code ignores is harmless; new code
against a missing column is not"_ — and this release did it backwards.

**The fix was NOT `pnpm apply`:** a full apply rewrites roles and has twice
taken production agent access down. The three fields were POSTed directly to
`/fields/conversations`, copying exactly what `fieldPayload()` in `apply.ts`
builds (`dateTime` -> `timestamp`, `choices` -> `select-dropdown` +
`{text,value}` options, `default_value: 'customer'`).

**BEFORE THE PRODUCTION TAG, THE SAME THREE FIELDS MUST EXIST ON PROD.** They
are additive and the old code ignores them, so they can go in first — and they
must, or the SLA sweep breaks on production exactly as it did here.
