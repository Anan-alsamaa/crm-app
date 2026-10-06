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
import { isAutomatedAgentMessage } from '@yiji/shared-types';

export interface TimingMessage {
  conversation: string;
  /** 'customer' | 'agent' | 'system' — anything else is ignored. */
  sender_type: string;
  date_created: string | null;
  /**
   * The agent who sent this message, when it was an agent.
   *
   * Optional so every existing caller keeps working: a caller that does not ask
   * for the field simply gets `firstAgentBy: null` and the old behaviour.
   */
  sender_user?: string | null;
}

export interface ConversationTimestamps {
  firstCustomerAt: string | null;
  firstAgentAt: string | null;
  /**
   * WHO actually sent that first reply.
   *
   * Needed because the chat may not still belong to them: the routing ladder
   * broadcasts and escalates, so `conversations.assigned_agent` is who holds it
   * NOW, which is often not who answered it. Crediting the response to the
   * assignee measured the wrong person — and excluding every re-offered chat
   * instead (the previous behaviour) emptied the metric completely, because on
   * production every chat is broadcast or escalated.
   *
   * Null when nobody replied, or when the caller did not request `sender_user`.
   */
  firstAgentBy: string | null;
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
  /* The agent messages, each keeping WHO sent it so the reply can be credited
     to the agent who actually made it. */
  const agentMsgs = new Map<string, Array<{ at: string; by: string | null }>>();

  for (const m of messages) {
    if (!m.date_created) continue;
    if (m.sender_type === 'customer') {
      const seen = firstCustomer.get(m.conversation);
      if (!seen || m.date_created < seen) firstCustomer.set(m.conversation, m.date_created);
    } else if (m.sender_type === 'agent') {
      /*
       * THE AUTOMATIC WELCOME IS NOT A REPLY (owner, 2026-10-06). It is sent a
       * second after the customer's first message, so counted it would make
       * every chat "answered within 5 minutes" by nobody. Recognised by the
       * shared rule — agent, `sender_user` null — which only fires when the
       * caller SELECTED `sender_user`; a caller that did not keeps the old
       * behaviour rather than losing every reply.
       */
      if (isAutomatedAgentMessage(m)) continue;
      const entry = { at: m.date_created, by: m.sender_user ?? null };
      const list = agentMsgs.get(m.conversation);
      if (list) list.push(entry);
      else agentMsgs.set(m.conversation, [entry]);
    }
  }

  const out = new Map<string, ConversationTimestamps>();
  for (const id of new Set([...firstCustomer.keys(), ...agentMsgs.keys()])) {
    const customerAt = firstCustomer.get(id) ?? null;
    const agents = agentMsgs.get(id) ?? [];
    // ISO-8601 UTC strings compare correctly as strings, and every timestamp
    // here comes from Directus in that form.
    const eligible = customerAt ? agents.filter((m) => m.at >= customerAt) : agents;
    // The earliest eligible reply, kept whole so its sender travels with its
    // time — picking the time and then re-searching for the sender is how the
    // two drift apart on a tie.
    const first = eligible.length ? eligible.reduce((a, b) => (a.at <= b.at ? a : b)) : null;
    out.set(id, {
      firstCustomerAt: customerAt,
      // With no customer message at all there is nothing to respond to, so the
      // earliest agent message stands in — the chat is still "answered", it
      // just has no measurable interval, which is what a null says.
      firstAgentAt: first?.at ?? null,
      firstAgentBy: first?.by ?? null,
    });
  }
  return out;
}
