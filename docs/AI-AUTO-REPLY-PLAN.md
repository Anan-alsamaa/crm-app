# AI auto-reply: plan for review

**Status:** proposal for the owner's review, 2026-10-13. Nothing is built yet.
**Where:** staging only. It goes to production later, in a batch with other
finished features, after the owner's double confirmation.

## 1. What it does

When a customer writes, the AI answers by itself in the normal support tone.
It handles the simple, common questions end to end. When a question needs a
person, it hands the chat to an agent, together with a short summary of what
was said.

Agents can watch every AI chat live and **take over at any moment**: the
first message an agent types in that chat ends the AI's part.

## 2. What the AI may answer

Only from two sources:

1. **A knowledge base the team writes and edits** in the admin portal. This
   covers FAQs and policies: working hours, delivery areas, how coupons work,
   payment methods, how to cancel, and so on. The CRM has no such content
   today. **Writing it is the biggest piece of work, and it needs operations'
   input.** The AI does not make policy up; if the answer is not in the
   knowledge base, it hands over.
2. **The customer's real order status**, read from Yiji: the latest 3–5
   orders only, with the order's state, time and branch. For example: "Your
   order #1314302 left the branch at 9:12 and is on its way."

## 3. Hard limits: what the AI never does

- Never offers, promises or issues **coupons, compensation, refunds or
  credits**. Not even "we'll make it up to you".
- Never **changes or cancels** an order, and never promises a delivery time
  beyond what Yiji's status says.
- Never asks for card or bank details or passwords.
- Never discusses other customers, internal matters, or anything outside Yiji
  support.

These limits are enforced in two places:

- the AI's instructions;
- a check on every reply before it is sent. A reply that mentions
  compensation or a refund is **blocked and handed over** instead.

## 4. Handover to a human

The AI hands the chat to the normal agent queue when:

| Trigger                                                        | Example                                              |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| The customer asks for a person                                 | "I want to talk to someone" / "ابي موظف"             |
| The customer is upset                                          | angry tone, complaint wording, repeated frustration  |
| The customer asks for compensation, a refund or a coupon       | "I want my money back"                               |
| The order needs action                                         | missing or wrong item, very late order, cancellation |
| The customer sincerely asks whether it is a bot                | (see section 5)                                      |
| The AI is not sure, or the answer is not in the knowledge base |                                                      |
| The chat is not resolved after **3 AI replies**                | stops the AI from going round in circles             |

When it hands over:

1. The customer gets a short, natural line, for example "Let me check this
   with the team, one moment."
2. The chat goes to the normal routing: the next available agent, with
   escalation, as today.
3. The agent sees **a summary and the reason for the handover** at the top of
   the chat.

## 5. How it presents itself

- No "bot" label, banner or badge. Replies look like normal support replies.
- **It never claims to be human.** If a customer sincerely asks "am I talking
  to a bot?", it says it is the virtual assistant and hands over to a person
  straight away.
- To confirm with whoever handles legal or compliance for Yiji: Saudi rules on
  whether an automated assistant must say so. SDAIA's AI ethics principles
  stress transparency.

## 6. How it fits the rest of the CRM

- **Routing:** while the AI is handling a chat, the routing ladder waits; no
  agent is assigned yet. On handover, routing starts exactly as today.
- **Agent portal:** a chat the AI is handling shows an "AI handling" marker.
  Any agent may open it and take over. AI messages are labelled
  "AI assistant" for agents only; the customer never sees that label.
- **Reports and KPIs:** chats the AI resolved on its own are counted
  separately ("handled by AI"). Agents' first-response and solve times start
  at the **handover**, so the AI does not distort agents' numbers. The SLA
  clock for a handed-over chat also starts at the handover. (Decision needed,
  see section 9.)
- **New-chat alerts and sound:** fire on handover, not while the AI handles
  the chat.

## 7. Controls

In the admin portal's AI settings:

- **On/off per vendor.** It starts off.
- **Working-hours option:** AI on all day, or only outside shift.
- **Monthly spending cap.** At the cap, chats go straight to agents.
- **The knowledge base editor.**
- A **report** showing chats handled by AI vs handed over, handover reasons,
  and cost.

Every AI call is already logged with its tokens and cost (`ai_calls`).

## 8. Cost (Gemini 3.8 Flash, about 9,500 customer messages a month)

|              | Tokens / month | Cost now    | From Jan 2027 |
| ------------ | -------------- | ----------- | ------------- |
| Lean         | ~32M           | ~$36        | ~$72          |
| **Expected** | **~60–65M**    | **~$50–70** | ~$100–140     |
| Heavy        | ~110M          | ~$125       | ~$250         |

Ways to keep it lower:

- **Prompt caching:** the instructions and knowledge base are the same in
  every call, and Gemini charges 90% less for repeated content.
- **A limited thinking budget.**
- **Fixed answers without AI** for the most common questions.

## 9. Decisions needed from the owner

1. **When is the AI on?** All the time, or only outside agent hours (04:00–09:00)
   and when no agent is free?
2. **Who writes the knowledge base?** Operations, with a first draft from us
   based on the quick replies and past chats?
3. **SLA for handed-over chats:** does the clock start at the handover
   (recommended), or at the customer's first message?
4. **The "3 replies then hand over" limit:** keep 3, or change it?
5. **What name the AI signs with**, if any. Today support messages carry no
   per-agent name in the customer's chat, so no change is needed.

## 10. How we build it (all on staging)

1. **Knowledge base:** the collection, the admin editor, and a first draft of
   the content.
2. **Shadow mode:** the AI writes the reply it **would** send, visible to
   agents only and never sent to the customer. For a week, agents compare it
   with their own replies. This proves the quality and the handover decisions
   safely, before any customer sees an AI reply.
3. **Live on staging:** the AI replies on the staging test vendor and test
   chats; handover, the limits, the reports and the cost cap are all checked.
4. **Release checks**, added for the hard limits:
   - no AI reply ever contains compensation wording;
   - a handover always reaches an agent.
5. **Production**, later, in a batch, after the owner's double confirmation.
   It starts **off**, then goes on for one vendor or a few hours first.
