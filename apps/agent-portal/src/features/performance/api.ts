import { useQuery } from '@tanstack/react-query';
import { normaliseConversationStatus } from '@yiji/shared-types';
import { chatHandoffs, sessionTimingRows, type ChatTiming } from '@yiji/reports';
import { performanceRead } from '../../lib/job-producer.js';

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
  /**
   * ONE ROW PER SESSION (owner, 2026-11-05): a returning customer's thread is
   * several rows, one per visit. `sessionKey` is unique per row; the rating of
   * a session is the one given before `nextSessionAt`.
   */
  sessionKey?: string;
  nextSessionAt?: string | null;
}

export interface PerformanceFilters {
  /** Inclusive ISO date, local calendar day. */
  from?: string;
  to?: string;
  /** Directus user id, or '' for everyone. */
  agentId?: string;
  /**
   * The CRM vendor id (`vendors.id`) to narrow to (MV-7). Set only while 2+
   * vendors are active and one is chosen; absent, no clause is added and every
   * read is exactly what it was. Chats, tickets and coupons each carry their
   * own `vendor` column.
   */
  vendor?: string;
}

/**
 * The report's dates as the gateway reads them (performance-report.ts): from
 * the start of `from`, to the last millisecond of `to`. Session rows are cut
 * to the same instants, so a session is in range exactly when a chat was.
 */
function rangeOf(f: PerformanceFilters): { from: string | null; to: string | null } {
  return {
    from: f.from ? f.from.slice(0, 10) : null,
    to: f.to ? `${f.to.slice(0, 10)}T23:59:59.999Z` : null,
  };
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
  /* Where a SESSION starts (2026-11-05): the automatic welcome, and the
     gateway's marker on the message that reopened the chat. */
  source?: string | null;
  starts_session?: boolean | null;
}

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
      /* PER SESSION (owner, 2026-11-05): chats ACTIVE in the dates, every
         agent's - a session belongs to whoever answered it, so the agent
         filter is applied to the session rows below, not to the chats. */
      const { agentId: agentFilter, ...readFilters } = filters;
      const conversations = await performanceRead<ConversationRow>('conversations', readFilters, {
        sessions: true,
      });

      if (conversations.length === 0) return [];

      /* What each chat was about. Read separately: the subject lives on the
       * ticket, and a conversation with no ticket simply has none. Best-effort
       * — a permissions gap here must not empty the whole page. */
      const subjectOf = new Map<string, string>();
      const ticketOf = new Map<string, string>();
      try {
        const linked = await performanceRead<{
          id: string | number;
          conversation: string | null;
          subject: string | null;
          complaint_type: string | null;
        }>('linkedTickets', {}, { ids: conversations.map((c) => c.id) });
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

      const messages = await performanceRead<MessageRow>(
        'messages',
        {},
        {
          ids: conversations.map((c) => c.id),
          sessions: true,
        },
      );

      /**
       * EACH SESSION ITS OWN ROW (owner, 2026-11-05) - see sessionTimingRows in
       * @yiji/reports, shared with the admin console. A returning customer's
       * thread is split where each visit started, and each visit's first
       * response is measured on its own and credited to whoever answered it.
       */
      const range = rangeOf(filters);
      const sessions = sessionTimingRows(
        conversations,
        messages,
        range,
        (st) => normaliseConversationStatus(st) === 'solved',
      ).filter((r) => !agentFilter || r.agentId === agentFilter || r.firstAgentBy === agentFilter);

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
        const events = await performanceRead<{
          conversation: string;
          agent: string | null;
          outcome: string;
          stage: string;
        }>('routingEvents', {}, { ids: conversations.map((c) => c.id) });
        handoffs = chatHandoffs(events);
      } catch {
        /* no routing history readable — every chat counts as cleanly assigned */
      }

      return sessions.map((r) => {
        const c = r.conversation;
        /* Routing history is per thread, without times: it describes the
           session being worked on now, so only the newest session carries it. */
        const handoff = r.isLatestSession ? handoffs.get(c.id) : undefined;
        return {
          conversationId: c.id,
          sessionKey: r.sessionKey,
          nextSessionAt: r.nextSessionAt,
          /* NO OWNER = THE AGENT WHO ANSWERED (owner, 2026-10-11); an earlier
             session belongs to whoever answered it (2026-11-05). */
          agentId: r.agentId,
          // Placeholder; the page replaces it with the resolved name. See above.
          agentName: r.agentId ?? 'General',
          firstCustomerAt: r.firstCustomerAt,
          firstAgentBy: r.firstAgentBy,
          firstAgentAt: r.firstAgentAt,
          solvedAt: r.solvedAt,
          startedAt: r.startedAt,
          customer: c.contact?.name ?? c.contact?.phone ?? null,
          orderId: c.last_order_id,
          subject: subjectOf.get(c.id) ?? null,
          customerPhone: c.contact?.phone ?? null,
          ticketId: ticketOf.get(c.id) ?? null,
          passedOn: handoff?.passedOn ?? false,
          takenBy: handoff?.takenBy ?? null,
          // Agent-started chats are measured from the customer's reply, and one
          // the customer never answered is not "unanswered" (owner, 2026-10-07).
          initiatedBy: r.initiatedBy,
          firstOutreachAt: r.firstOutreachAt,
        };
      });
    },
  });
}

/** One customer rating, joined to the agent who handled the chat. */
export interface CsatRow {
  conversation: string | null;
  score: number | null;
  /** When it was given; present on the per-session read (2026-11-05). */
  submitted_at?: string | null;
}

/**
 * CSAT for the chats in range, keyed by conversation.
 *
 * Kept OUT of the timings query on purpose: ratings live in their own
 * collection and arrive late (a customer rates after the chat ends), so
 * folding them into the chat read would make every timing refetch wait on
 * them. The page joins the two by conversation id.
 */
export function useCsatByConversation(filters: PerformanceFilters, conversationIds: string[]) {
  return useQuery({
    /* BY CHAT, not by submission date (owner, 2026-10-11: a rating column per
       chat). A customer rates after the chat ends, so a window on the rating's
       own timestamp dropped late ratings of chats that ARE in range. */
    queryKey: ['csat-by-conversation', filters, conversationIds],
    enabled: conversationIds.length > 0,
    /* Every rating of each chat WITH its time (2026-11-05): a thread can hold
       several sessions, and `sessionRating` gives each session only its own. */
    queryFn: async (): Promise<Map<string, Array<{ score: number; at: string | null }>>> => {
      const rows = await performanceRead<CsatRow>(
        'csat',
        {},
        { ids: conversationIds, sessions: true },
      );
      const out = new Map<string, Array<{ score: number; at: string | null }>>();
      for (const r of rows) {
        if (!r.conversation || typeof r.score !== 'number') continue;
        const list = out.get(r.conversation) ?? [];
        list.push({ score: r.score, at: r.submitted_at ?? null });
        out.set(r.conversation, list);
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
      const tickets = await performanceRead<TicketReadRow>('tickets', filters);
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
        const coupons = await performanceRead<LinkedCoupon>(
          'ticketCoupons',
          {},
          {
            ids: tickets.map((tk) => String(tk.id)),
          },
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
      const rows = await performanceRead<PerformanceCouponRow>('coupons', filters);
      if (rows.length === 0) return [];

      const extra = async (field: CouponExtraField) => {
        try {
          const got = await performanceRead<Record<string, unknown> & { id: string }>(
            'couponExtra',
            filters,
            { field },
          );
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
