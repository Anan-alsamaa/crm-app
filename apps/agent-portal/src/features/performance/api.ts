import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { normaliseConversationStatus } from '@yiji/shared-types';
import { chatHandoffs, conversationTimestamps, type ChatTiming } from '@yiji/reports';
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
/**
 * A `ChatTiming` plus what the agent needs to recognise the chat.
 *
 * The timings alone answer "how fast"; these answer "which one" — without them
 * the per-chat breakdown is a column of uuids and an agent cannot go and look
 * at the conversation that dragged their average.
 */
export interface ChatTimingRow extends ChatTiming {
  startedAt: string | null;
  customer: string | null;
  orderId: string | null;
  /**
   * What the chat was ABOUT — the linked ticket's complaint type, falling back
   * to its subject. A row of timings tells you how fast; the subject tells you
   * what was slow, which is the half a supervisor acts on.
   */
  subject: string | null;
}

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
  contact: { id: string; name: string | null; phone: string | null } | null;
  last_order_id: string | null;
}

interface MessageRow {
  conversation: string;
  sender_type: 'customer' | 'agent' | 'system';
  date_created: string | null;
}

/** End of the chosen day, so a `to` of today includes everything today. */
const endOfDay = (isoDate: string) => `${isoDate}T23:59:59.999Z`;

/**
 * NOTE: this deliberately does NOT resolve agent names.
 *
 * It used to take the name map and bake the names into the rows — but the map
 * arrives from a SEPARATE query, and the cache key was only the filters. So the
 * first fetch ran with an empty map, cached rows carrying raw uuids, and never
 * re-ran when the names landed: the page showed
 * "076e68d6-61ff-4525-a01a-caf18ec0d514" where an agent's name belongs.
 *
 * Names are resolved at render instead. Cached data now holds only what this
 * query actually fetched, which is the property that made the bug possible to
 * have in the first place.
 */
export function useChatTimings(filters: PerformanceFilters) {
  return useQuery({
    queryKey: ['chat-timings', filters],
    queryFn: async (): Promise<ChatTimingRow[]> => {
      const and: Array<Record<string, unknown>> = [];
      if (filters.from) and.push({ date_created: { _gte: filters.from } });
      if (filters.to) and.push({ date_created: { _lte: endOfDay(filters.to) } });
      if (filters.agentId) and.push({ assigned_agent: { _eq: filters.agentId } });

      const conversations = (await directus.request(
        readItems('conversations', {
          limit: -1,
          fields: [
            'id',
            'status',
            'assigned_agent',
            'solved_at',
            'date_created',
            // The per-chat breakdown names the customer and the order. A row of
            // timings against a uuid is a number nobody can act on.
            'last_order_id',
            { contact: ['id', 'name', 'phone'] },
          ],
          ...(and.length ? { filter: { _and: and } } : {}),
        }),
      )) as unknown as ConversationRow[];

      if (conversations.length === 0) return [];

      /* What each chat was about. Read separately: the subject lives on the
       * ticket, and a conversation with no ticket simply has none. Best-effort
       * — a permissions gap here must not empty the whole page. */
      const subjectOf = new Map<string, string>();
      try {
        const linked = (await directus.request(
          readItems('tickets', {
            limit: -1,
            filter: { conversation: { _in: conversations.map((c) => c.id) } },
            fields: ['conversation', 'subject', 'complaint_type'],
            sort: ['-date_created'],
          }),
        )) as unknown as Array<{
          conversation: string | null;
          subject: string | null;
          complaint_type: string | null;
        }>;
        for (const tk of linked) {
          if (!tk.conversation) continue;
          const label = tk.complaint_type?.trim() || tk.subject?.trim();
          // Newest ticket wins; the sort above puts it first.
          if (label && !subjectOf.has(tk.conversation)) subjectOf.set(tk.conversation, label);
        }
      } catch {
        /* no ticket read access — rows fall back to the customer alone */
      }

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

      /**
       * Shared with the admin console — see conversationTimestamps in
       * @yiji/reports. It also enforces the rule this code used to miss: the
       * first response is the first agent message AT OR AFTER the customer's,
       * so an agent who greeted before the customer wrote is not reported as
       * having never replied.
       */
      const times = conversationTimestamps(messages);

      /**
       * Which of these chats the auto-assignment ladder had to pass on.
       *
       * A chat that went round the ladder carries the seconds the earlier
       * agents spent not answering it, so it leaves the personal first-response
       * population and is counted as a COMMON chat for whoever picked it up.
       * See chatHandoffs in @yiji/reports.
       *
       * Fail-soft: an older permission set without `routing_events` read should
       * cost the common-chat column, not the whole page.
       */
      let handoffs = new Map<string, { passedOn: boolean; takenBy: string | null }>();
      try {
        const events = (await directus.request(
          readItems('routing_events', {
            limit: -1,
            filter: { conversation: { _in: conversations.map((c) => c.id) } },
            fields: ['conversation', 'agent', 'outcome', 'stage'],
          }),
        )) as unknown as Array<{
          conversation: string;
          agent: string | null;
          outcome: string;
          stage: string;
        }>;
        handoffs = chatHandoffs(events);
      } catch {
        /* no routing history readable — every chat counts as cleanly assigned */
      }

      return conversations.map((c) => ({
        conversationId: c.id,
        agentId: c.assigned_agent,
        // Placeholder; the page replaces it with the resolved name. See above.
        agentName: c.assigned_agent ?? 'Unassigned',
        firstCustomerAt: times.get(c.id)?.firstCustomerAt ?? null,
        firstAgentAt: times.get(c.id)?.firstAgentAt ?? null,
        // A chat can hold a solve time from before it was reopened only if
        // something failed to clear it; trust the status over the stamp.
        solvedAt: normaliseConversationStatus(c.status) === 'solved' ? c.solved_at : null,
        startedAt: c.date_created,
        customer: c.contact?.name ?? c.contact?.phone ?? null,
        orderId: c.last_order_id,
        subject: subjectOf.get(c.id) ?? null,
        passedOn: handoffs.get(c.id)?.passedOn ?? false,
        takenBy: handoffs.get(c.id)?.takenBy ?? null,
      }));
    },
  });
}
