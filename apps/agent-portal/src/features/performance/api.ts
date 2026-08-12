import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { normaliseConversationStatus } from '@yiji/shared-types';
import type { ChatTiming } from '@yiji/reports';
import { directus } from '../../lib/directus.js';

/**
 * Chat timings for the agent-performance report.
 *
 * Two reads, not one. The first-response measure needs the customer's first
 * message and the agent's first reply, and those live in `messages`, not on the
 * conversation. Directus cannot aggregate "first row per group" across a
 * relation, so the messages are fetched for exactly the conversations in range
 * and reduced here.
 *
 * Internal notes are excluded: a note is the team talking to itself, and
 * counting one as a reply would report the customer as answered when nobody
 * has said anything to them.
 */
export interface PerformanceFilters {
  /** Inclusive ISO date, local calendar day. */
  from?: string;
  to?: string;
  /** Directus user id, or '' for everyone. */
  agentId?: string;
}

interface ConversationRow {
  id: string;
  status: string;
  assigned_agent: string | null;
  solved_at: string | null;
  date_created: string | null;
}

interface MessageRow {
  conversation: string;
  sender_type: 'customer' | 'agent' | 'system';
  date_created: string | null;
}

/** End of the chosen day, so a `to` of today includes everything today. */
const endOfDay = (isoDate: string) => `${isoDate}T23:59:59.999Z`;

export function useChatTimings(filters: PerformanceFilters, agentNames: Map<string, string>) {
  return useQuery({
    queryKey: ['chat-timings', filters],
    queryFn: async (): Promise<ChatTiming[]> => {
      const and: Array<Record<string, unknown>> = [];
      if (filters.from) and.push({ date_created: { _gte: filters.from } });
      if (filters.to) and.push({ date_created: { _lte: endOfDay(filters.to) } });
      if (filters.agentId) and.push({ assigned_agent: { _eq: filters.agentId } });

      const conversations = (await directus.request(
        readItems('conversations', {
          limit: -1,
          fields: ['id', 'status', 'assigned_agent', 'solved_at', 'date_created'],
          ...(and.length ? { filter: { _and: and } } : {}),
        }),
      )) as unknown as ConversationRow[];

      if (conversations.length === 0) return [];

      const messages = (await directus.request(
        readItems('messages', {
          limit: -1,
          filter: {
            conversation: { _in: conversations.map((c) => c.id) },
            is_internal_note: { _eq: false },
          },
          fields: ['conversation', 'sender_type', 'date_created'],
          sort: ['date_created'],
        }),
      )) as unknown as MessageRow[];

      // Sorted ascending, so the FIRST hit per conversation per side wins.
      const firstCustomer = new Map<string, string>();
      const firstAgent = new Map<string, string>();
      for (const m of messages) {
        if (!m.date_created) continue;
        const bucket =
          m.sender_type === 'customer'
            ? firstCustomer
            : m.sender_type === 'agent'
              ? firstAgent
              : null;
        if (!bucket || bucket.has(m.conversation)) continue;
        bucket.set(m.conversation, m.date_created);
      }

      return conversations.map((c) => ({
        conversationId: c.id,
        agentId: c.assigned_agent,
        agentName: c.assigned_agent
          ? (agentNames.get(c.assigned_agent) ?? c.assigned_agent)
          : 'Unassigned',
        firstCustomerAt: firstCustomer.get(c.id) ?? null,
        firstAgentAt: firstAgent.get(c.id) ?? null,
        // A chat can hold a solve time from before it was reopened only if
        // something failed to clear it; trust the status over the stamp.
        solvedAt: normaliseConversationStatus(c.status) === 'solved' ? c.solved_at : null,
      }));
    },
  });
}
