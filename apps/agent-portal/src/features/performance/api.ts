import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { normaliseConversationStatus } from '@yiji/shared-types';
import { chatHandoffs, conversationTimestamps, readChunked, type ChatTiming } from '@yiji/reports';
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
  /** The customer's number, kept apart from the name so the search box can
      find a chat by phone even when the contact has a name (owner, 2026-10-07). */
  customerPhone?: string | null;
  /** The newest ticket raised from this chat, searchable by id (owner, 2026-10-07). */
  ticketId?: string | null;
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
  /** 'agent' when an agent opened the chat (owner, 2026-10-07). */
  initiated_by: string | null;
}

interface MessageRow {
  conversation: string;
  sender_type: 'customer' | 'agent' | 'system';
  date_created: string | null;
  /* Who sent it, so a reply is credited to the agent who made it rather than to
     whoever holds the chat now — the ladder moves chats. */
  sender_user: string | null;
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
            'initiated_by',
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
      const ticketOf = new Map<string, string>();
      try {
        // Chunked: every conversation id in one query string is an HTTP 414
        // from CloudFront once the count grows. See readChunked.
        const linked = await readChunked<{
          id: string | number;
          conversation: string | null;
          subject: string | null;
          complaint_type: string | null;
        }>(
          conversations.map((c) => c.id),
          (ids) =>
            directus.request(
              readItems('tickets', {
                limit: -1,
                filter: { conversation: { _in: ids } },
                fields: ['id', 'conversation', 'subject', 'complaint_type'],
                sort: ['-date_created'],
              }),
            ) as unknown as Promise<
              Array<{
                id: string | number;
                conversation: string | null;
                subject: string | null;
                complaint_type: string | null;
              }>
            >,
        );
        for (const tk of linked) {
          if (!tk.conversation) continue;
          // Newest ticket wins; the sort above puts it first.
          if (!ticketOf.has(tk.conversation)) ticketOf.set(tk.conversation, String(tk.id));
          const label = tk.complaint_type?.trim() || tk.subject?.trim();
          if (label && !subjectOf.has(tk.conversation)) subjectOf.set(tk.conversation, label);
        }
      } catch {
        /* no ticket read access — rows fall back to the customer alone */
      }

      const messages = await readChunked<MessageRow>(
        conversations.map((c) => c.id),
        (ids) =>
          directus.request(
            readItems('messages', {
              limit: -1,
              filter: {
                conversation: { _in: ids },
                is_internal_note: { _eq: false },
              },
              fields: ['conversation', 'sender_type', 'date_created', 'sender_user'],
              sort: ['date_created'],
            }),
          ) as unknown as Promise<MessageRow[]>,
      );

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
        const events = await readChunked<{
          conversation: string;
          agent: string | null;
          outcome: string;
          stage: string;
        }>(
          conversations.map((c) => c.id),
          (ids) =>
            directus.request(
              readItems('routing_events', {
                limit: -1,
                filter: { conversation: { _in: ids } },
                fields: ['conversation', 'agent', 'outcome', 'stage'],
              }),
            ) as unknown as Promise<
              Array<{
                conversation: string;
                agent: string | null;
                outcome: string;
                stage: string;
              }>
            >,
        );
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
        firstAgentBy: times.get(c.id)?.firstAgentBy ?? null,
        firstAgentAt: times.get(c.id)?.firstAgentAt ?? null,
        // A chat can hold a solve time from before it was reopened only if
        // something failed to clear it; trust the status over the stamp.
        solvedAt: normaliseConversationStatus(c.status) === 'solved' ? c.solved_at : null,
        startedAt: c.date_created,
        customer: c.contact?.name ?? c.contact?.phone ?? null,
        orderId: c.last_order_id,
        subject: subjectOf.get(c.id) ?? null,
        customerPhone: c.contact?.phone ?? null,
        ticketId: ticketOf.get(c.id) ?? null,
        passedOn: handoffs.get(c.id)?.passedOn ?? false,
        takenBy: handoffs.get(c.id)?.takenBy ?? null,
        // Agent-started chats are measured from the customer's reply, and one
        // the customer never answered is not "unanswered" (owner, 2026-10-07).
        initiatedBy: c.initiated_by === 'agent' ? ('agent' as const) : ('customer' as const),
        firstOutreachAt: times.get(c.id)?.firstAgentAnyAt ?? null,
      }));
    },
  });
}

/** One customer rating, joined to the agent who handled the chat. */
export interface CsatRow {
  conversation: string | null;
  score: number | null;
}

/**
 * CSAT for the chats in range, keyed by conversation.
 *
 * Kept OUT of the timings query on purpose: ratings live in their own
 * collection and arrive late (a customer rates after the chat ends), so
 * folding them into the chat read would make every timing refetch wait on
 * them. The page joins the two by conversation id.
 */
export function useCsatByConversation(filters: PerformanceFilters) {
  return useQuery({
    queryKey: ['csat-by-conversation', filters],
    queryFn: async (): Promise<Map<string, number>> => {
      const and: Array<Record<string, unknown>> = [];
      if (filters.from) and.push({ submitted_at: { _gte: filters.from } });
      if (filters.to) and.push({ submitted_at: { _lte: `${filters.to}T23:59:59.999Z` } });
      const rows = (await directus.request(
        readItems(
          'csat_responses' as never,
          {
            limit: -1,
            fields: ['conversation', 'score'],
            ...(and.length ? { filter: { _and: and } } : {}),
          } as never,
        ),
      )) as unknown as CsatRow[];
      const out = new Map<string, number>();
      for (const r of rows) {
        if (!r.conversation || typeof r.score !== 'number') continue;
        out.set(r.conversation, r.score);
      }
      return out;
    },
  });
}

/* ── Tickets and coupons (owner, 2026-10-07) ──────────────────────────────
 *
 * "Faisal assigned a coupon which came for admin approval, however in the
 * Agent performance page I'm unable to find the ticket." The page measured
 * CHATS only, so a ticket raised from the Add-ticket page, or a coupon request,
 * had nowhere to appear. These two reads back the Tickets and Coupons tabs.
 */

/** A ticket in range, as the Tickets tab lists it. */
export interface PerformanceTicketRow {
  id: string;
  subject: string | null;
  complaintType: string | null;
  orderId: string | null;
  status: string | null;
  assignedAgent: string | null;
  /** Who raised it — an agent's own ticket counts even when it went elsewhere. */
  createdBy: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
  contactName: string | null;
  contactPhone: string | null;
  customerPhone: string | null;
  /** The newest coupon request linked to the ticket, when there is one. */
  coupon: { code: string | null; status: string } | null;
}

interface TicketReadRow {
  id: string | number;
  subject: string | null;
  complaint_type?: string | null;
  order_id?: string | null;
  status: string | null;
  assigned_agent: string | null;
  user_created: string | null;
  date_created: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  customer_phone?: string | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
}

/**
 * Tickets created in range that belong to the agent: ASSIGNED to them OR RAISED
 * by them. Either alone misses half — an agent raises a ticket for the branch
 * team, or is handed one somebody else opened.
 */
export function useTicketPerformance(filters: PerformanceFilters, enabled = true) {
  return useQuery({
    queryKey: ['performance-tickets', filters],
    enabled,
    // A refusal is an answer, not a blip — the tab renders it calmly.
    retry: false,
    queryFn: async (): Promise<PerformanceTicketRow[]> => {
      const and: Array<Record<string, unknown>> = [];
      if (filters.from) and.push({ date_created: { _gte: filters.from } });
      if (filters.to) and.push({ date_created: { _lte: endOfDay(filters.to) } });
      if (filters.agentId)
        and.push({
          _or: [
            { assigned_agent: { _eq: filters.agentId } },
            { user_created: { _eq: filters.agentId } },
          ],
        });
      const tickets = (await directus.request(
        readItems('tickets', {
          limit: -1,
          fields: [
            'id',
            'subject',
            'complaint_type',
            'order_id',
            'status',
            'assigned_agent',
            'user_created',
            'date_created',
            'resolved_at',
            'closed_at',
            'customer_phone',
            { contact: ['id', 'name', 'phone'] },
          ],
          sort: ['-date_created'],
          ...(and.length ? { filter: { _and: and } } : {}),
        } as never),
      )) as unknown as TicketReadRow[];
      if (tickets.length === 0) return [];

      /* The coupon on each ticket. Best-effort: a role that cannot read the
         coupon queue still gets its tickets, just without the coupon column. */
      const couponOf = new Map<string, { code: string | null; status: string }>();
      try {
        type LinkedCoupon = {
          ticket: string | number | null;
          coupon_code: string | null;
          status: string;
        };
        const coupons = await readChunked<LinkedCoupon>(
          tickets.map((tk) => String(tk.id)),
          (ids) =>
            directus.request(
              readItems(
                'coupon_approvals' as never,
                {
                  limit: -1,
                  filter: { ticket: { _in: ids } },
                  fields: ['ticket', 'coupon_code', 'status'],
                  sort: ['-date_created'],
                } as never,
              ),
            ) as unknown as Promise<LinkedCoupon[]>,
        );
        for (const c of coupons) {
          if (c.ticket == null) continue;
          const key = String(c.ticket);
          // Newest first, so the first one seen is the current request.
          if (!couponOf.has(key)) couponOf.set(key, { code: c.coupon_code, status: c.status });
        }
      } catch {
        /* no coupon read access — the column stays empty */
      }

      return tickets.map((tk) => ({
        id: String(tk.id),
        subject: tk.subject,
        complaintType: tk.complaint_type ?? null,
        orderId: tk.order_id ?? null,
        status: tk.status,
        assignedAgent: tk.assigned_agent,
        createdBy: tk.user_created,
        createdAt: tk.date_created,
        resolvedAt: tk.resolved_at ?? tk.closed_at ?? null,
        contactName: tk.contact?.name ?? null,
        contactPhone: tk.contact?.phone ?? null,
        customerPhone: tk.customer_phone ?? null,
        coupon: couponOf.get(String(tk.id)) ?? null,
      }));
    },
  });
}

/** A coupon request in range, as the Coupons tab lists it. */
export interface PerformanceCouponRow {
  id: string;
  coupon_code: string | null;
  coupon_value: number | null;
  coupon_percent: number | null;
  discount_category: string | null;
  status: string;
  date_created: string | null;
  order_id: string | null;
  customer_phone: string | null;
  ticket: {
    id: string | number;
    subject: string | null;
    order_id: string | null;
    complaint_type?: string | null;
  } | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
  requested_by: { id: string; first_name: string | null; email: string | null } | null;
  /** Read separately — see below. Undefined when the field could not be read. */
  delivery_excluded?: boolean | null;
  yiji_coupon_id?: string | null;
  awaiting_signup_at?: string | null;
  /**
   * The ticket's id as STORED on the request. A role restricted to its own
   * tickets gets `ticket: null` from the expansion above when the ticket went
   * to somebody else — a related item you cannot read comes back NULL — and
   * the row would lose the one link the owner asked for.
   */
  ticketId?: string | null;
}

type CouponExtraField = 'delivery_excluded' | 'yiji_coupon_id' | 'awaiting_signup_at' | 'ticket';

/**
 * Coupon requests RAISED by the agent in range (All agents = everyone).
 *
 * The three delivery fields are each read in their OWN best-effort query: on an
 * environment where one of them was never bootstrapped, naming it would make
 * Directus 403 the WHOLE read, and the tab would show nothing at all for want
 * of one status nuance. The main read carries only long-standing columns.
 */
export function useCouponPerformance(filters: PerformanceFilters, enabled = true) {
  return useQuery({
    queryKey: ['performance-coupons', filters],
    enabled,
    retry: false,
    queryFn: async (): Promise<PerformanceCouponRow[]> => {
      const and: Array<Record<string, unknown>> = [];
      if (filters.from) and.push({ date_created: { _gte: filters.from } });
      if (filters.to) and.push({ date_created: { _lte: endOfDay(filters.to) } });
      if (filters.agentId) and.push({ requested_by: { _eq: filters.agentId } });
      const filter = and.length ? { filter: { _and: and } } : {};

      const rows = (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            limit: -1,
            sort: ['-date_created'],
            fields: [
              'id',
              'coupon_code',
              'coupon_value',
              'coupon_percent',
              'discount_category',
              'status',
              'date_created',
              'order_id',
              'customer_phone',
              { ticket: ['id', 'subject', 'order_id', 'complaint_type'] },
              { contact: ['id', 'name', 'phone'] },
              { requested_by: ['id', 'first_name', 'email'] },
            ],
            ...filter,
          } as never,
        ),
      )) as unknown as PerformanceCouponRow[];
      if (rows.length === 0) return [];

      const extra = async (field: CouponExtraField) => {
        try {
          const got = (await directus.request(
            readItems(
              'coupon_approvals' as never,
              { limit: -1, fields: ['id', field], ...filter } as never,
            ),
          )) as unknown as Array<Record<string, unknown> & { id: string }>;
          return new Map(got.map((g) => [String(g.id), g[field]]));
        } catch {
          return null;
        }
      };
      const [excluded, yijiId, awaiting, rawTicket] = await Promise.all([
        extra('delivery_excluded'),
        extra('yiji_coupon_id'),
        extra('awaiting_signup_at'),
        extra('ticket'),
      ]);
      const pick = <T>(m: Map<string, unknown> | null, id: string): T | null | undefined =>
        m ? ((m.get(id) as T | null | undefined) ?? null) : undefined;
      return rows.map((r) => ({
        ...r,
        delivery_excluded: pick<boolean>(excluded, String(r.id)),
        yiji_coupon_id: pick<string>(yijiId, String(r.id)),
        awaiting_signup_at: pick<string>(awaiting, String(r.id)),
        ticketId:
          r.ticket?.id != null
            ? String(r.ticket.id)
            : ((v) => (v == null ? null : String(v)))(
                pick<string | number>(rawTicket, String(r.id)),
              ),
      }));
    },
  });
}
