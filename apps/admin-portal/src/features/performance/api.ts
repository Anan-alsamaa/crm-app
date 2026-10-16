import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { normaliseConversationStatus, displayContactName } from '@yiji/shared-types';
import { chatHandoffs, conversationTimestamps, readChunked, type ChatTiming } from '@yiji/reports';
import { directus } from '../../lib/directus.js';
import { businessDayWindow } from '../../lib/date-range.js';
import { loadTicketSolveContext } from '../../lib/ticket-solve.js';

/**
 * The admin console's agent-performance reads.
 *
 * WHY THIS PAGE WAS SLOW (owner, 2026-10-12: "the agent performance page takes
 * time to load"). Four causes, all on the client:
 *
 *   1. It opened on ALL TIME. No date = every conversation ever, then every
 *      message of every one of them (`limit: -1`), chunked 120 chats at a time.
 *   2. The three supporting reads (linked tickets, messages, routing events)
 *      ran ONE AFTER ANOTHER, and each one's chunks ran one after another too,
 *      so the page waited for 3 x (chats / 120) round trips in series.
 *   3. The portal-wide 30-second poll (main.tsx) re-ran that whole chain every
 *      30 seconds while the page was open — on a long range, before the
 *      previous run had finished.
 *   4. (New with the tabs) tickets and coupons would have added their reads on
 *      top; they now load only when their tab is opened.
 *
 * The page now opens on yesterday + today (as the agent portal does), the three
 * supporting reads run side by side with two chunks in flight each, and this
 * report refreshes every five minutes rather than every thirty seconds. The
 * arithmetic is untouched — it is still @yiji/reports, shared with the agent
 * portal, so the two can never report different numbers for the same week.
 */

export interface PerformanceFilters {
  /** Inclusive ISO date (business day). */
  from?: string;
  to?: string;
  /** Directus user id, or '' / undefined for everyone. */
  agentId?: string;
}

/* The END of a BUSINESS day (owner, 2026-09-30): 04:00 the NEXT morning, not
   23:59 the same night. A chat solved at 01:00 belongs to the shift that opened
   the evening before, and `T23:59:59` cut every night's tail off the measure. */
const endOfDay = (isoDate: string) => businessDayWindow(isoDate, isoDate).toIso;

/** Date window on `field`, as Directus `_and` clauses. */
function dateWindow(filters: PerformanceFilters, field = 'date_created') {
  const and: Array<Record<string, unknown>> = [];
  if (filters.from) and.push({ [field]: { _gte: filters.from } });
  if (filters.to) and.push({ [field]: { _lte: endOfDay(filters.to) } });
  return and;
}

/**
 * How fresh a report read is kept. The portal default polls every 30s, which is
 * right for an approval queue and wrong for a read that fans out into hundreds
 * of message rows per chat: it re-ran the whole report twice a minute. Five
 * minutes still updates a screen left open; a date change re-reads at once.
 */
export const REPORT_FRESHNESS = { staleTime: 60_000, refetchInterval: 5 * 60_000 } as const;

/** Supporting `_in` chunks in flight at once, per dataset. See readChunked. */
const CHUNK_CONCURRENCY = 2;

/** A `ChatTiming` plus what the admin needs to recognise — and search for — the chat. */
export type AdminChatTiming = ChatTiming & {
  startedAt: string | null;
  /** Who the chat was with — name, else the phone we recognise them by. */
  customer: string | null;
  /** What it was ABOUT: the linked ticket's complaint type, else its subject. */
  subject: string | null;
  /** The customer's number, kept apart from the name so search finds it by phone. */
  customerPhone: string | null;
  /** The order the chat was last about. */
  orderId: string | null;
  /** The newest ticket raised from this chat, searchable by id. */
  ticketId: string | null;
};

type Rows<T> = Promise<T[]>;
const read = <T>(collection: string, query: Record<string, unknown>): Rows<T> =>
  directus.request(readItems(collection as never, query as never)) as unknown as Rows<T>;

/**
 * Deliberately does NOT resolve agent names — see the user portal's copy of
 * this hook. The names come from a separate query, and a cache keyed only on
 * the filters will hold rows resolved against an empty map forever, rendering
 * uuids where names belong. Names are attached at render.
 */
export function useChatTimings(filters: PerformanceFilters, enabled = true) {
  return useQuery({
    queryKey: ['admin-chat-timings', filters],
    enabled,
    ...REPORT_FRESHNESS,
    queryFn: async (): Promise<AdminChatTiming[]> => {
      const and = dateWindow(filters);
      if (filters.agentId) and.push({ assigned_agent: { _eq: filters.agentId } });

      const conversations = await read<{
        id: string;
        status: string;
        assigned_agent: string | null;
        solved_at: string | null;
        date_created: string | null;
        initiated_by: string | null;
        last_order_id?: string | null;
        contact: { id: string; name: string | null; phone: string | null } | null;
      }>('conversations', {
        limit: -1,
        fields: [
          'id',
          'status',
          'assigned_agent',
          'solved_at',
          'date_created',
          'initiated_by',
          'last_order_id',
          { contact: ['id', 'name', 'phone'] },
        ],
        ...(and.length ? { filter: { _and: and } } : {}),
      });
      if (conversations.length === 0) return [];
      const ids = conversations.map((c) => c.id);

      /*
       * The three supporting reads are independent — each needs only the chat
       * ids — so they run SIDE BY SIDE (owner, 2026-10-12). In series the page
       * waited for the sum of all three; now it waits for the slowest.
       * Chunked: every id in one query string is an HTTP 414 from CloudFront
       * once the count grows (see readChunked).
       */
      const [linked, messages, events] = await Promise.all([
        /* What each chat was about. Best-effort so a permissions gap cannot
         * empty the page. */
        readChunked(
          ids,
          (chunk) =>
            read<{
              id: string | number;
              conversation: string | null;
              subject: string | null;
              complaint_type: string | null;
            }>('tickets', {
              limit: -1,
              filter: { conversation: { _in: chunk } },
              fields: ['id', 'conversation', 'subject', 'complaint_type'],
              sort: ['-date_created'],
            }),
          undefined,
          CHUNK_CONCURRENCY,
        ).catch(() => [] /* no ticket read access — rows fall back to the customer */),
        // First response needs the messages: the conversation row knows when
        // it started, never when somebody answered.
        readChunked(
          ids,
          (chunk) =>
            read<{
              conversation: string;
              sender_type: string;
              date_created: string | null;
              sender_user: string | null;
            }>('messages', {
              limit: -1,
              filter: { conversation: { _in: chunk }, is_internal_note: { _eq: false } },
              /* `sender_user` so a reply is credited to the agent who SENT
                 it — the ladder moves chats, so the assignee is often not the
                 replier. */
              fields: ['conversation', 'sender_type', 'date_created', 'sender_user'],
              sort: ['date_created'],
            }),
          undefined,
          CHUNK_CONCURRENCY,
        ),
        /* Which chats the ladder had to pass on — see chatHandoffs. Fail-soft:
           no routing history readable = every chat cleanly assigned. */
        readChunked(
          ids,
          (chunk) =>
            read<{ conversation: string; agent: string | null; outcome: string; stage: string }>(
              'routing_events',
              {
                limit: -1,
                filter: { conversation: { _in: chunk } },
                fields: ['conversation', 'agent', 'outcome', 'stage'],
              },
            ),
          undefined,
          CHUNK_CONCURRENCY,
        ).catch(() => null),
      ]);

      const subjectOf = new Map<string, string>();
      const ticketOf = new Map<string, string>();
      for (const tk of linked) {
        if (!tk.conversation) continue;
        // Newest ticket wins — the sort above puts it first.
        if (!ticketOf.has(tk.conversation)) ticketOf.set(tk.conversation, String(tk.id));
        const label = tk.complaint_type?.trim() || tk.subject?.trim();
        if (label && !subjectOf.has(tk.conversation)) subjectOf.set(tk.conversation, label);
      }

      // Shared with the agent portal — see conversationTimestamps in
      // @yiji/reports. Two portals reducing the same messages by hand is how
      // they came to agree on a wrong "No reply".
      const times = conversationTimestamps(messages);
      /**
       * Chats the ladder passed on leave the personal first-response population
       * and become COMMON chats for whoever picked them up, because the wait
       * they carry was created by the agents who did not answer first.
       */
      const handoffs = events
        ? chatHandoffs(events)
        : new Map<string, { passedOn: boolean; takenBy: string | null }>();

      return conversations.map((c) => ({
        conversationId: c.id,
        // No owner = the agent who answered; see the agent portal (2026-10-11).
        agentId: c.assigned_agent ?? times.get(c.id)?.firstAgentBy ?? null,
        // Placeholder; the page replaces it with the resolved name.
        agentName: c.assigned_agent ?? times.get(c.id)?.firstAgentBy ?? 'General',
        firstCustomerAt: times.get(c.id)?.firstCustomerAt ?? null,
        firstAgentAt: times.get(c.id)?.firstAgentAt ?? null,
        firstAgentBy: times.get(c.id)?.firstAgentBy ?? null,
        solvedAt: normaliseConversationStatus(c.status) === 'solved' ? c.solved_at : null,
        // Carried so a chat nobody ever wrote in still lands on a day in the
        // trend instead of vanishing from it.
        startedAt: c.date_created,
        /* THROUGH `displayContactName` (owner, 2026-10-05): a `+966…` name
           renders as `05…`. It already falls back to the phone, so the old
           `?? phone` chain folds into it — null only when nothing is known. */
        customer: displayContactName(c.contact?.name, c.contact?.phone) || null,
        customerPhone: c.contact?.phone ?? null,
        orderId: c.last_order_id ?? null,
        subject: subjectOf.get(c.id) ?? null,
        ticketId: ticketOf.get(c.id) ?? null,
        passedOn: handoffs.get(c.id)?.passedOn ?? false,
        takenBy: handoffs.get(c.id)?.takenBy ?? null,
        // Agent-started chats are measured from the customer's reply; one the
        // customer never answered is not "unanswered" (owner, 2026-10-07).
        initiatedBy: c.initiated_by === 'agent' ? ('agent' as const) : ('customer' as const),
        firstOutreachAt: times.get(c.id)?.firstAgentAnyAt ?? null,
      }));
    },
  });
}

/**
 * CSAT for the chats in range, keyed by conversation — see the agent portal's
 * copy for why it is a separate read.
 */
export function useCsatByConversation(filters: PerformanceFilters, enabled = true) {
  return useQuery({
    queryKey: ['admin-csat-by-conversation', filters.from, filters.to],
    enabled,
    ...REPORT_FRESHNESS,
    queryFn: async (): Promise<Map<string, number>> => {
      const and = dateWindow(filters, 'submitted_at');
      const rows = await read<{ conversation: string | null; score: number | null }>(
        'csat_responses',
        {
          limit: -1,
          fields: ['conversation', 'score'],
          ...(and.length ? { filter: { _and: and } } : {}),
        },
      );
      const out = new Map<string, number>();
      for (const r of rows) {
        if (!r.conversation || typeof r.score !== 'number') continue;
        out.set(r.conversation, r.score);
      }
      return out;
    },
  });
}

/* ── Tickets and coupons (owner, 2026-10-12) ──────────────────────────────
 *
 * "We need 3 different: chats, tickets, coupons, all like the user portal."
 * The same two datasets the agent portal's tabs read (through the gateway's
 * `performance-report.ts`, field for field), read here with the admin's own
 * Directus session — an admin reviews the whole team, so no server-side
 * widening is needed.
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
  /**
   * The facts the shared ticket solve rule (`ticketSolveSec`) needs — the same
   * the Agent summary and Ticket deadlines feed it: the first customer message
   * of the chat the ticket came from, and the server's own solve time when
   * `resolvedAt` is missing or runs behind the creation stamp.
   */
  chatStartAt: string | null;
  solvedServerAt: string | null;
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
  conversation?: string | null;
  customer_phone?: string | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
}

/**
 * Tickets created in range that belong to the agent: ASSIGNED to them OR RAISED
 * by them. Either alone misses half — an agent raises a ticket for the branch
 * team, or is handed one somebody else opened. All agents = every ticket.
 */
export function useTicketPerformance(filters: PerformanceFilters, enabled = true) {
  return useQuery({
    queryKey: ['admin-performance-tickets', filters],
    enabled,
    ...REPORT_FRESHNESS,
    // A refusal is an answer, not a blip — the tab renders it calmly.
    retry: false,
    queryFn: async (): Promise<PerformanceTicketRow[]> => {
      const and = dateWindow(filters);
      if (filters.agentId)
        and.push({
          _or: [
            { assigned_agent: { _eq: filters.agentId } },
            { user_created: { _eq: filters.agentId } },
          ],
        });
      const tickets = await read<TicketReadRow>('tickets', {
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
          'conversation',
          'customer_phone',
          { contact: ['id', 'name', 'phone'] },
        ],
        sort: ['-date_created'],
        ...(and.length ? { filter: { _and: and } } : {}),
      });
      if (tickets.length === 0) return [];

      /* The coupon on each ticket. Best-effort: a role that cannot read the
         coupon queue still gets its tickets, just without the coupon column. */
      const couponOf = new Map<string, { code: string | null; status: string }>();
      try {
        const coupons = await readChunked(
          tickets.map((tk) => String(tk.id)),
          (chunk) =>
            read<{ ticket: string | number | null; coupon_code: string | null; status: string }>(
              'coupon_approvals',
              {
                limit: -1,
                filter: { ticket: { _in: chunk } },
                fields: ['ticket', 'coupon_code', 'status'],
                sort: ['-date_created'],
              },
            ),
          undefined,
          CHUNK_CONCURRENCY,
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

      /* Best-effort: a failed read is the bare created -> resolved interval. */
      const solveCtx = await loadTicketSolveContext(
        tickets.map((tk) => ({
          id: String(tk.id),
          status: tk.status,
          date_created: tk.date_created,
          resolved_at: tk.resolved_at ?? tk.closed_at ?? null,
          conversation: tk.conversation ?? null,
        })),
      );

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
        chatStartAt: solveCtx.session.get(String(tk.id))?.customerAt ?? null,
        solvedServerAt: solveCtx.solvedServerAt.get(String(tk.id)) ?? null,
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
   * The ticket's id as STORED on the request: a related item the reader cannot
   * read comes back NULL from the expansion, and the row would lose its ticket.
   */
  ticketId?: string | null;
}

type CouponExtraField = 'delivery_excluded' | 'yiji_coupon_id' | 'awaiting_signup_at' | 'ticket';

/**
 * Coupon requests RAISED by the agent in range (All agents = everyone).
 *
 * The delivery fields are each read in their OWN best-effort query, in
 * parallel: on an environment where one was never bootstrapped, naming it
 * would make Directus 403 the WHOLE read. The main read carries only
 * long-standing columns.
 */
export function useCouponPerformance(filters: PerformanceFilters, enabled = true) {
  return useQuery({
    queryKey: ['admin-performance-coupons', filters],
    enabled,
    ...REPORT_FRESHNESS,
    retry: false,
    queryFn: async (): Promise<PerformanceCouponRow[]> => {
      const and = dateWindow(filters);
      if (filters.agentId) and.push({ requested_by: { _eq: filters.agentId } });
      const filter = and.length ? { filter: { _and: and } } : {};

      const extra = async (field: CouponExtraField) => {
        try {
          const got = await read<Record<string, unknown> & { id: string | number }>(
            'coupon_approvals',
            { limit: -1, fields: ['id', field], ...filter },
          );
          return new Map(got.map((g) => [String(g.id), g[field]]));
        } catch {
          return null;
        }
      };
      /* The main read and its four extras together — none depends on another,
         and in series they were five round trips before the tab could draw. */
      const [rows, excluded, yijiId, awaiting, rawTicket] = await Promise.all([
        read<PerformanceCouponRow>('coupon_approvals', {
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
        }),
        extra('delivery_excluded'),
        extra('yiji_coupon_id'),
        extra('awaiting_signup_at'),
        extra('ticket'),
      ]);
      if (rows.length === 0) return [];
      const pick = <T>(m: Map<string, unknown> | null, id: string): T | null | undefined =>
        m ? ((m.get(id) as T | null | undefined) ?? null) : undefined;
      return rows.map((r) => {
        const stored = pick<string | number | { id: string | number }>(rawTicket, String(r.id));
        const storedId =
          stored == null ? null : typeof stored === 'object' ? String(stored.id) : String(stored);
        return {
          ...r,
          delivery_excluded: pick<boolean>(excluded, String(r.id)),
          yiji_coupon_id: pick<string>(yijiId, String(r.id)),
          awaiting_signup_at: pick<string>(awaiting, String(r.id)),
          ticketId: r.ticket?.id != null ? String(r.ticket.id) : storedId,
        };
      });
    },
  });
}
