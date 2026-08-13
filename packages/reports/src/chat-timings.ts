/**
 * Reducing a conversation's messages to the two timestamps the performance
 * report measures from.
 *
 * This lives here, shared, because both portals need it and both got it wrong
 * in the same way: each took the FIRST agent message in the conversation as the
 * reply. On a chat the agent opened — a greeting, an outreach template, the
 * normal WhatsApp pattern — that message predates the customer's first, the
 * interval is negative, and the negative-duration guard (correctly) discards
 * it. The page then rendered "No reply" for a conversation with three visible
 * agent replies in it, inflated the unanswered count, dropped a real response
 * time out of every average, and dragged the SLA rate down. Both portals agreed
 * on the wrong number, so there was no second source to catch it.
 *
 * The rule: the first response is the first agent message AT OR AFTER the
 * customer's first message. An agent talking before the customer has said
 * anything is not responding to anything.
 */

export interface TimingMessage {
  conversation: string;
  /** 'customer' | 'agent' | 'system' — anything else is ignored. */
  sender_type: string;
  date_created: string | null;
}

export interface ConversationTimestamps {
  firstCustomerAt: string | null;
  firstAgentAt: string | null;
}

/**
 * Per-conversation first-customer and first-response times.
 *
 * `messages` must exclude internal notes — a note is the team talking to
 * itself, and counting one as a reply reports the customer as answered when
 * nobody has spoken to them. Sort order is not assumed: every candidate is
 * compared, so a caller that forgets `sort: ['date_created']` still gets the
 * right answer rather than a plausible wrong one.
 */
export function conversationTimestamps(
  messages: readonly TimingMessage[],
): Map<string, ConversationTimestamps> {
  const firstCustomer = new Map<string, string>();
  const agentTimes = new Map<string, string[]>();

  for (const m of messages) {
    if (!m.date_created) continue;
    if (m.sender_type === 'customer') {
      const seen = firstCustomer.get(m.conversation);
      if (!seen || m.date_created < seen) firstCustomer.set(m.conversation, m.date_created);
    } else if (m.sender_type === 'agent') {
      const list = agentTimes.get(m.conversation);
      if (list) list.push(m.date_created);
      else agentTimes.set(m.conversation, [m.date_created]);
    }
  }

  const out = new Map<string, ConversationTimestamps>();
  for (const id of new Set([...firstCustomer.keys(), ...agentTimes.keys()])) {
    const customerAt = firstCustomer.get(id) ?? null;
    const agents = agentTimes.get(id) ?? [];
    // ISO-8601 UTC strings compare correctly as strings, and every timestamp
    // here comes from Directus in that form.
    const eligible = customerAt ? agents.filter((t) => t >= customerAt) : agents;
    out.set(id, {
      firstCustomerAt: customerAt,
      // With no customer message at all there is nothing to respond to, so the
      // earliest agent message stands in — the chat is still "answered", it
      // just has no measurable interval, which is what a null says.
      firstAgentAt: eligible.length ? eligible.reduce((a, b) => (a < b ? a : b)) : null,
    });
  }
  return out;
}
