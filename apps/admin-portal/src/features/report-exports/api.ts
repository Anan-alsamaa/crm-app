import { useQuery } from '@tanstack/react-query';
import { aggregate, readItems, readRevisions, readUsers } from '@directus/sdk';
import { formatDateTime } from '@yiji/ui';
import { directus } from '../../lib/directus.js';
import { commerce } from '../../lib/commerce-client.js';
import { displayContactName, type StoreSnapshot } from '@yiji/shared-types';
// The complaints row shape is shared with the agent portal — see @yiji/reports.
// The chat arithmetic (timestamps, handoffs, per-agent rollup) is the SAME
// shared code the two Agent-performance pages use, so this report can never
// disagree with them about an agent's numbers.
import {
  agentPerformance,
  chatHandoffs,
  agentInitiatedSummary,
  conversationTimestamps,
  firstResponseSec,
  readChunked,
  splitLocalDateTime,
  type ComplaintReportRow,
} from '@yiji/reports';
import {
  normaliseConversationStatus,
  normaliseTicketStatus,
  compensationFlag,
} from '@yiji/shared-types';

export type { ComplaintReportRow };

/**
 * Agent reports — three exportable cuts the client asked for (feature #8), all
 * computed client-side from the collections an agent can already read (same
 * approach as the admin SLA reports / dashboard; no worker round-trip):
 *
 *   1. Tickets + order data — every ticket with its SLA timings and the linked
 *      customer's latest Yiji order (restaurant / status / delivery / items).
 *   2. Agent KPI — per agent: first-response time(s) and CSAT satisfaction.
 *   3. Conversation status — conversations grouped by status / priority / day.
 *
 * The base data (1 Directus round-trip per collection) loads fast; the order
 * enrichment for report #1 is a SEPARATE, bounded, best-effort pass over the
 * commerce proxy so a slow/unavailable Yiji API never blocks the report.
 */

/* ── Shared raw shapes ────────────────────────────────────────────────── */

/**
 * `2026-08-13T19:11:04Z` → `13/08/2026 19:11`, local time.
 *
 * dd/mm/yyyy, because this reaches the SCREEN — it is what the "Last modified
 * at" column shows. It used to emit `2026-08-13 19:11`: defensible for a file
 * that gets sorted, wrong for a report column sitting beside a dozen dates the
 * rest of the app writes as dd/mm/yyyy (owner, 2026-09-24). The export's own
 * `fmtDateTime` in export.ts keeps ISO on purpose, for sorting in a spreadsheet.
 */
const fmtStamp = (iso: string): string => formatDateTime(iso);

interface RawTicket {
  user_updated?: string | null;
  date_updated?: string | null;
  id: string;
  subject: string | null;
  /** The Yiji order, used to match a coupon raised before the link existed. */
  order_id?: string | null;
  status: string;
  priority: string;
  assigned_agent: string | null;
  date_created: string | null;
  /** When the complaint happened. Null on tickets raised before the field
   *  existed, which fall back to date_created. */
  complaint_date?: string | null;
  first_response_due_at: string | null;
  first_responded_at: string | null;
  resolution_due_at: string | null;
  resolved_at: string | null;
  contact: { id: string; name: string | null; email: string | null; phone: string | null } | null;
  /* The operations complaint fields. Optional on the type because they are
   * requested best-effort — see COMPLAINT_FIELDS. */
  description?: string | null;
  complaint_type?: string | null;
  service_type?: string | null;
  complaint_source?: string | null;
  communication_method?: string | null;
  response_desc?: string | null;
  compensation?: string | null;
  coupon_code?: string | null;
  coupon_value?: number | null;
  coupon_percent?: number | null;
  order_snapshot?: RawOrderSnapshot | null;
  store_snapshot?: StoreSnapshot | null;
}

/** The stored point-in-time order copy, as much of it as this report reads. */
interface RawOrderSnapshot {
  orderId?: string | null;
  total?: number | null;
  currency?: string | null;
  brandName?: string | null;
  restaurantName?: string | null;
  restaurantId?: string | null;
}

interface RawConversation {
  id: string;
  status: string;
  priority: string;
  assigned_agent: string | null;
  date_created: string | null;
  solved_at: string | null;
  last_message_at: string | null;
  contact: { id: string; name: string | null; phone: string | null; email: string | null } | null;
  last_order_id: string | null;
  /** 'agent' when an agent opened the chat (owner, 2026-10-07). */
  initiated_by?: string | null;
}

interface RawCsat {
  id: string;
  score: number | null;
  comment: string | null;
  submitted_at: string | null;
  conversation: string | null;
}

interface RawUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

/* ── Public report shapes ─────────────────────────────────────────────── */

export type SlaOutcome = 'met' | 'breached' | 'pending' | 'na';

export interface TicketReportRow {
  id: string;
  subject: string;
  status: string;
  priority: string;
  contactId: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  agentName: string;
  createdAt: string | null;
  /** Minutes from creation to first response (null if not yet responded). */
  firstResponseMinutes: number | null;
  firstResponseState: SlaOutcome;
  /** Minutes from creation to resolution (null if unresolved). */
  resolutionMinutes: number | null;
  resolutionState: SlaOutcome;
  /** Best-effort linked-order enrichment (undefined until/if it resolves). */
  order?: TicketOrderInfo | null;
  /** Branch attribution frozen at ticket creation; null on older tickets. */
  storeSnapshot: StoreSnapshot | null;
}

export interface TicketOrderInfo {
  orderId: string;
  restaurant: string;
  status: string;
  delivery: string;
  items: string;
  total: number | null;
  currency: string;
  /* Raw values straight off the order, kept so the store lookup can run on
   * them. `restaurant` above is a display join and is lossy for matching. */
  rawBrandName?: string;
  rawRestaurantName?: string;
  rawRestaurantId?: string;
  /* Resolved from the operations store master data (see @yiji/shared-types
   * restaurants). Present once the store index has loaded. */
  brand?: string;
  city?: string;
  areaManager?: string;
  chainManager?: string;
  /** False when no store row matched — surfaced as "Not mapped" in the sheet. */
  storeMapped?: boolean;
}

/**
 * One row of the operations manager's own complaints report.
 *
 * The columns, their order and their names come from the sheet operations
 * have kept by hand (`Complaints_History_Import.csv`, 1,673 rows covering
 * 2026-01-01 → 2026-07-31), so that the same report can be produced from the
 * CRM instead of maintained manually — and so the two can be compared
 * column-for-column while both exist.
 *
 * `date` and `time` are separate on purpose: her sheet splits them, and the
 * split is what makes the by-hour cut possible in Excel without a formula.
 *
 * Store-derived fields (chain, area, brand, city, restaurant) come from the
 * order snapshot joined onto the store master — NOT from a live order lookup,
 * so rows keep reporting correctly long after the upstream order has changed.
 */
export interface AgentKpiRow {
  agentId: string | null;
  agentName: string;
  /*
   * Tickets in range, and nothing else about tickets. `responded`,
   * `avgFirstResponseMin` and `firstResponsePct` used to sit here; no screen or
   * file ever showed them, and they were the only reason the Agent summary
   * fetched every ticket row in full (2026-10-05). The count now comes from a
   * server-side aggregate.
   */
  tickets: number;
  csatCount: number;
  /** Mean CSAT score 1–5 over the agent's rated conversations. */
  csatAvg: number | null;
  /** Conversations auto-assigned to this agent that they did not answer in time. */
  missed: number;
  /** Auto-assignment offers made to them — the denominator for `missed`. */
  offered: number;
  /* Chat metrics — the SAME measures (and the same shared arithmetic) as the
   * two Agent-performance pages, so this report evaluates agents by the
   * numbers a supervisor already watches. */
  /** Chats assigned in range. */
  chats: number;
  /** Chats with no agent reply at all. */
  noReply: number;
  /** Chats picked up after somebody else let them go. */
  commonTaken: number;
  /** Chats this agent STARTED (owner, 2026-10-07). */
  agentStarted: number;
  /** ...of which the customer replied. */
  agentStartedReplied: number;
  /**
   * MEDIAN seconds to first reply over the chats the agent answered.
   *
   * The median, not the mean (owner decision, 2026-10-05). One chat answered
   * the next morning is worth hundreds of quick replies in a mean, so a single
   * overnight wait could make a fast agent read as the slowest on the team. The
   * median is what a typical customer of theirs waited.
   */
  medianFirstResponseSec: number | null;
  /** Mean seconds from first message to solved. */
  avgTimeToSolveSec: number | null;
  /** % of own answered chats answered within the 5-minute target. */
  inTimePct: number | null;
}

export interface StatusCount {
  key: string;
  count: number;
}
export interface DayStatusCount {
  day: string;
  total: number;
  byStatus: Record<string, number>;
}
export interface ConversationRow {
  id: string;
  status: string;
  priority: string;
  agentName: string;
  createdAt: string | null;
  lastMessageAt: string | null;
  /**
   * Who the conversation is WITH. A status report that counts twenty open
   * chats without saying whose they are is a number; with the phone numbers it
   * is a list somebody can work through.
   */
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  /** The order the chat was last seen to be about, when there is one. */
  orderId: string;
  /**
   * A customer has written and NO agent has replied yet.
   *
   * The same signal Agent summary counts as "Not replied", read off the same
   * first-message timings, so the dashboard tile and that column can never
   * disagree about how many people are waiting.
   *
   * Deliberately not "no activity for N minutes": an agent's own last message
   * would reset that, so a chat nobody has answered and a chat somebody
   * answered a minute ago would look identical.
   */
  awaitingReply: boolean;
  /** Minutes since the customer's first message, when awaiting a reply. */
  waitingMinutes: number | null;
  /** Who opened the chat (owner, 2026-10-07). */
  startedBy: 'agent' | 'customer';
}

export interface ConversationStatusReport {
  rows: ConversationRow[];
  byStatus: StatusCount[];
  byPriority: StatusCount[];
  byDay: DayStatusCount[];
  statuses: string[];
  total: number;
}

export interface AgentReportData {
  tickets: TicketReportRow[];
  /** Rows for the Complaints report, before the store join is applied. */
  complaints: ComplaintReportRow[];
  /**
   * False when this Directus does not yet carry the operations complaint
   * fields, so the Complaints report can say "the schema is not applied here"
   * instead of rendering 24 columns of blanks and looking broken.
   */
  complaintFieldsAvailable: boolean;
  /**
   * Tickets LOGGED in this window whose complaint date falls outside it.
   *
   * The report is filtered by when a complaint HAPPENED, which is the right
   * question for "complaints in August" — but it means somebody who logs a
   * three-week-old complaint today does not find it in today's window, and
   * reads that as the ticket having failed to save. Reported by operations as
   * "a created ticket is not showing in the admin portal".
   *
   * Widening the filter is the wrong fix: on this data the whole imported
   * history shares one creation stamp, so every window would return all 1,693
   * rows and "August" would list January. Instead the report keeps its honest
   * filter and SAYS what it is leaving out, with the range that would show it.
   *
   * Null when the count could not be taken — a failed extra query must never
   * empty a report that already has its rows.
   */
  loggedOutsideWindow: { count: number; earliest: string; latest: string } | null;
  agents: AgentKpiRow[];
  conversations: ConversationStatusReport;
  /** Overall CSAT across all rated conversations in the window. */
  csatOverall: { avg: number | null; count: number };
  generatedAt: string;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;

function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const start = new Date(a).getTime();
  const end = new Date(b).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const diff = (end - start) / 60_000;
  return diff >= 0 ? diff : null;
}

/** met / breached / pending / na from a due + done pair. */
function slaOutcome(dueAt: string | null, doneAt: string | null, now: number): SlaOutcome {
  if (!dueAt) return 'na';
  if (doneAt) return new Date(doneAt).getTime() <= new Date(dueAt).getTime() ? 'met' : 'breached';
  return new Date(dueAt).getTime() < now ? 'breached' : 'pending';
}

function displayName(u: RawUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '—';
}

/**
 * Read a collection filtered by a potentially large id set, one chunk per
 * request. See `readChunked` in @yiji/reports for why this is necessary — in
 * short, a few hundred ids in a query string is an HTTP 414 from CloudFront.
 */
function readByIdsChunked<T>(
  collection: string,
  ids: string[],
  build: (idChunk: string[]) => Record<string, unknown>,
  /** Chunks in flight at once; 1 (strictly in series) unless a caller asks. */
  concurrency = 1,
): Promise<T[]> {
  return readChunked(
    ids,
    (chunk) =>
      directus.request(readItems(collection as never, build(chunk) as never) as never) as Promise<
        T[]
      >,
    undefined,
    concurrency,
  );
}

/** Ticket fields every report needs. */
const BASE_TICKET_FIELDS = [
  'id',
  'subject',
  'status',
  'priority',
  'assigned_agent',
  'date_created',
  'first_response_due_at',
  'first_responded_at',
  'resolution_due_at',
  'resolved_at',
  // The audit stamp: who touched the ticket last, and when. System columns, so
  // they cover imports and raw API writes, not just portal edits.
  'user_updated',
  'date_updated',
  { contact: ['id', 'name', 'email', 'phone'] },
] as const;

/**
 * The operations complaint fields, requested on top of the base set.
 *
 * Fetched in the SAME query rather than a second round-trip, but behind a
 * retry: a Directus that has not had the complaint schema applied rejects the
 * whole request for one unknown field, which would take Tickets, Agent KPI and
 * Conversation status down with it. One failed attempt then costs a second
 * request; the alternative costs every other report on this page.
 */
const COMPLAINT_FIELDS = [
  'complaint_date',
  'description',
  'complaint_type',
  'service_type',
  'complaint_source',
  'communication_method',
  'response_desc',
  'compensation',
  'coupon_code',
  'coupon_value',
  'coupon_percent',
  'order_snapshot',
  // Read so a coupon with no ticket link can still be matched to its ticket by
  // the order both name — every coupon raised before 2026-09-29 has no link.
  'order_id',
  'store_snapshot',
] as const;

/**
 * What the ticket BREAKDOWN renders and exports, and nothing more (2026-10-05).
 *
 * It used to read the base set as well — subject, priority, four SLA stamps,
 * the audit stamps, contact id and email — none of which any of its columns
 * shows. On the full history that was 11.2 MB, past the 10 MB above which
 * CloudFront stops compressing, so the whole payload crossed the wire raw:
 * 8.8 s. This list is 9.3 MB and 3.3 s on the same rows.
 *
 * The snapshots stay WHOLE. `store_snapshot` is the frozen branch attribution
 * and is read in full by the store join. `order_snapshot` supplies brand,
 * branch, total and order number; asking for just those four paths with
 * `json(order_snapshot, …)` was measured too and saved 0.4 MB while costing
 * the database the extraction (no faster), and it needs a Directus new enough
 * to have `json()` — an older one would reject the whole query.
 */
const BREAKDOWN_TICKET_FIELDS = [
  'id',
  'status',
  'assigned_agent',
  'date_created',
  { contact: ['name', 'phone'] },
  ...COMPLAINT_FIELDS,
] as const;

/** The four reports this loader serves — see `useAgentReportData`. */
export type AgentReportKind = 'tickets' | 'agents' | 'conversations' | 'complaints';

/** Numeric cell that tolerates the sheet's `-`, `""` and `"102.85 SR"`. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /-?\d+(\.\d+)?/.exec(v.replace(/,/g, ''));
  return m ? Number(m[0]) : null;
}

/* ── Base report data (Directus only — no commerce) ───────────────────── */

/**
 * @param range explicit `from`/`to` (yyyy-mm-dd). Wins over `days`, exactly as
 *              the SLA report already behaves — somebody who has typed two
 *              dates has asked a more specific question than "the last 30
 *              days", and answering the vaguer one ignores what they typed.
 */
export function useAgentReportData(
  days: number,
  labels: { unassigned: string; noSubject: string },
  range?: { from?: string; to?: string },
  /**
   * Which report is ASKING, so only its data is fetched (2026-10-05).
   *
   * One loader served every report and fetched everything for each: the Agent
   * summary pulled every ticket row in full to count them per agent, and the
   * ticket breakdown pulled every chat and message it never shows. Measured on
   * production after the 7,912-ticket import, that was 5.1 s on the default
   * range and 17.8 s on the full history. Omitted = everything, as before.
   */
  kind?: AgentReportKind,
) {
  const from = range?.from?.trim() || '';
  const to = range?.to?.trim() || '';
  return useQuery({
    // The key carries everything the data resolved against — a range missing
    // from here serves the previous range's rows under the new dates. The kind
    // too: an Agent summary result has no ticket rows to lend a breakdown.
    queryKey: ['agent-reports', kind ?? 'all', days, from, to, labels.unassigned, labels.noSubject],
    /* Five minutes, not one (2026-10-05). These are reports over weeks or
       months of history, not a live queue; refetching all of it every time a
       tab regained focus was a large share of the waiting. The changes made
       from THIS portal (a coupon decision, a ticket delete, an import)
       invalidate 'agent-reports' explicitly, so those show at once; work done
       by agents elsewhere shows within five minutes. */
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<AgentReportData> => {
      try {
        return await loadAgentReport(days, labels, { from, to }, kind);
      } catch (err) {
        // Report the cause. A generic "could not load" on a page that made
        // twenty successful requests sends whoever is looking hunting through
        // the network tab for a failure that is not there.
        console.error('[agent-reports] failed to build the report', (err as Error)?.stack ?? err);
        throw err;
      }
    },
  });
}

type RawCoupon = {
  id: string;
  ticket: string | null;
  order_id: string | null;
  status: string | null;
  compensation: string | null;
};

type RawRevision = {
  item: string;
  activity: { action: string; timestamp: string; user: string | null } | null;
};

type RawRoutingEvent = {
  conversation: string;
  agent: string | null;
  outcome: string;
  stage: string;
};

/**
 * An optional read: its fallback stands in for ANY failure, including one
 * thrown synchronously while the request is being built, so a single missing
 * column or collection can never reject the batch it runs in.
 */
const attempt = <T>(read: () => Promise<T>, fallback: (err: unknown) => T): Promise<T> =>
  Promise.resolve().then(read).catch(fallback);

/** Directus returns an aggregate count as a STRING (Postgres bigint). */
const countOf = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function loadAgentReport(
  days: number,
  labels: { unassigned: string; noSubject: string },
  range?: { from?: string; to?: string },
  kind?: AgentReportKind,
): Promise<AgentReportData> {
  {
    {
      const since = range?.from
        ? `${range.from}T00:00:00`
        : new Date(Date.now() - days * DAY_MS).toISOString();
      /** Inclusive of the end day: "up to the 17th" means including the 17th. */
      const until = range?.to ? `${range.to}T23:59:59` : '';
      const inRange = (field: string) => ({
        [field]: until ? { _gte: since, _lte: until } : { _gte: since },
      });
      const now = Date.now();

      /*
       * WHAT THIS REPORT ACTUALLY SHOWS, so only that is fetched (2026-10-05).
       *
       *   ticketRows    the ticket rows themselves (Tickets, ticket breakdown)
       *   ticketCounts  only how many per agent (Agent summary) — one aggregate
       *   chats         conversations + their messages (Agent summary, Conversations)
       *   agentKpi      CSAT + routing history (Agent summary)
       *   breakdown     coupons, last editor, logged-outside-window (breakdown)
       *
       * No kind = every part, exactly as before.
       */
      const all = !kind;
      const needs = {
        ticketRows: all || kind === 'tickets' || kind === 'complaints',
        ticketCounts: kind === 'agents',
        chats: all || kind === 'agents' || kind === 'conversations',
        agentKpi: all || kind === 'agents',
        breakdown: all || kind === 'complaints',
      };

      // Attempt the richer field list first; fall back to the base one if this
      // Directus has no complaint schema (see COMPLAINT_FIELDS).
      let complaintFieldsAvailable = true;
      /**
       * Filter on WHEN THE COMPLAINT HAPPENED, falling back to creation.
       *
       * This report displays, sorts and groups by `complaint_date`; filtering
       * on `date_created` asked a different question than the one the table
       * answers. Imported history makes the gap total rather than subtle —
       * 1,621 rows spanning nine months share one creation stamp, so "August"
       * returned 7 tickets where the honest answer was 17, and narrowing the
       * range to any window before today emptied the report of everything that
       * was ever imported.
       *
       * The `_or` is what keeps older rows visible: tickets raised before the
       * complaint-date field existed have none, and matching only on
       * `complaint_date` would silently drop every one of them.
       */
      const ticketWindow = {
        _or: [
          inRange('complaint_date'),
          { _and: [{ complaint_date: { _null: true } }, inRange('date_created')] },
        ],
      };
      const readTickets = async (): Promise<RawTicket[]> => {
        if (!needs.ticketRows) return [];
        const query = (fields: readonly unknown[], filter: unknown) =>
          directus.request(
            readItems('tickets', {
              filter: filter as never,
              fields: fields as never,
              limit: -1,
              sort: ['-date_created'],
            }),
          ) as Promise<RawTicket[]>;
        try {
          // The breakdown reads only its own columns — see BREAKDOWN_TICKET_FIELDS.
          return await query(
            kind === 'complaints'
              ? BREAKDOWN_TICKET_FIELDS
              : [...BASE_TICKET_FIELDS, ...COMPLAINT_FIELDS],
            ticketWindow,
          );
        } catch {
          // No complaint schema here: neither the fields nor the window that
          // reads `complaint_date` can work, so both fall back together.
          complaintFieldsAvailable = false;
          return await query(BASE_TICKET_FIELDS, inRange('date_created'));
        }
      };
      /*
       * TICKETS PER AGENT, COUNTED BY THE SERVER (2026-10-05).
       *
       * The Agent summary shows one ticket number per agent. It used to get it
       * by downloading every ticket in range — order and store snapshots and
       * all, 10.9 MB on the full history — and counting in the browser. A
       * grouped count is one request of about half a kilobyte (0.26 s measured
       * on production). Same window and same fallback as the rows.
       */
      const readTicketCounts = async (): Promise<Map<string | null, number>> => {
        const out = new Map<string | null, number>();
        if (!needs.ticketCounts) return out;
        const query = (filter: unknown) =>
          directus.request(
            aggregate(
              'tickets' as never,
              {
                aggregate: { count: '*' },
                groupBy: ['assigned_agent'],
                query: { filter },
              } as never,
            ),
          ) as unknown as Promise<Array<{ assigned_agent?: string | null; count?: unknown }>>;
        let rows: Array<{ assigned_agent?: string | null; count?: unknown }>;
        try {
          rows = await query(ticketWindow);
        } catch {
          rows = await query(inRange('date_created'));
        }
        for (const r of rows) {
          const id = r.assigned_agent ?? null;
          out.set(id, (out.get(id) ?? 0) + countOf(r.count));
        }
        return out;
      };

      /*
       * EVERY INDEPENDENT READ IN ONE BATCH (2026-10-05).
       *
       * Routing events, the last-editor lookup and the outside-window count
       * used to run one after another AFTER this batch and after the messages,
       * so the report waited for the sum of them rather than the slowest. None
       * of them needs anything this batch returns. Each optional read carries
       * its own catch, as it did before: a missing collection or a refused
       * permission costs that one column, never the report.
       */
      const [
        tickets,
        ticketCounts,
        conversations,
        csat,
        users,
        coupons,
        routingEvents,
        revisions,
        outside,
      ] = await Promise.all([
        readTickets(),
        readTicketCounts(),
        needs.chats
          ? (directus.request(
              readItems('conversations', {
                filter: inRange('date_created'),
                fields: [
                  'id',
                  'status',
                  'priority',
                  'assigned_agent',
                  'date_created',
                  'solved_at',
                  'last_message_at',
                  // Expanded, not a bare id: the status report names and PHONES the
                  // customers behind each count. "20 open" is a number; twenty
                  // phone numbers is a morning's work.
                  { contact: ['id', 'name', 'phone', 'email'] },
                  'last_order_id',
                  'initiated_by',
                ],
                limit: -1,
                sort: ['-date_created'],
              }),
            ) as Promise<RawConversation[]>)
          : Promise.resolve([] as RawConversation[]),
        needs.agentKpi
          ? (directus.request(
              readItems('csat_responses', {
                filter: inRange('submitted_at'),
                fields: ['id', 'score', 'comment', 'submitted_at', 'conversation'],
                limit: -1,
              }),
            ) as Promise<RawCsat[]>)
          : Promise.resolve([] as RawCsat[]),
        directus.request(
          readUsers({ fields: ['id', 'first_name', 'last_name', 'email'], limit: -1 }),
        ) as Promise<RawUser[]>,
        /*
         * THE COUPONS, because compensation does not live on the ticket.
         *
         * `tickets.compensation` is written by the ticket FORM — the path where
         * an agent raises a complaint and attaches a coupon in one go. A late
         * order does not go through that form: the decision writes the ticket
         * and the coupon form writes `coupon_approvals.compensation`, so the
         * ticket's own column stayed null and the breakdown reported three
         * compensated late orders as "Not Compensated" (owner, 2026-09-29).
         *
         * Read UNFILTERED by date: a coupon approved today can answer a ticket
         * raised yesterday, and a window on the coupon would drop exactly the
         * rows this is here to find. It is a small collection.
         */
        needs.breakdown
          ? (directus.request(
              readItems(
                'coupon_approvals' as never,
                {
                  fields: ['id', 'ticket', 'order_id', 'status', 'compensation'],
                  limit: -1,
                } as never,
              ),
            ) as Promise<RawCoupon[]>)
          : Promise.resolve([] as RawCoupon[]),
        // Auto-assignment outcomes + handoffs — see where they are tallied.
        needs.agentKpi
          ? attempt(
              () =>
                directus.request(
                  readItems('routing_events' as never, {
                    filter: inRange('date_created'),
                    fields: ['conversation', 'agent', 'outcome', 'stage'],
                    limit: -1,
                  }) as never,
                ) as Promise<RawRoutingEvent[]>,
              // Collection not provisioned yet (bootstrap not re-run) — report
              // zeroes rather than failing the whole KPI over one metric.
              () => [] as RawRoutingEvent[],
            )
          : Promise.resolve([] as RawRoutingEvent[]),
        /*
         * Who last edited each ticket, from the AUDIT TRAIL — see `lastEditBy`
         * below for why not `user_updated`.
         *
         * `readRevisions`, NOT `readItems('directus_revisions')`.
         *
         * A Directus SYSTEM collection is not served from `/items/...`:
         * `readItems('directus_revisions')` builds `/items/directus_revisions`,
         * which answers 403 FORBIDDEN however complete the role's permissions
         * are — and this role HAS `directus_revisions.read`. The 403 landed in
         * the catch, `lastEditBy` stayed empty, and both columns rendered blank
         * for every ticket, on a report whose whole job is to say who touched
         * it last. The agent portal's own history panel was right all along
         * because it used `readRevisions` (owner, 2026-09-24).
         *
         * ONE QUERY, filtered to what the lookup keeps (2026-10-05). It used
         * to ask for EVERY revision of the tickets in range, by id, 120 ids at
         * a time: 67 requests on the full history, 7.5 s, for rows that were
         * then thrown away unless they were a human's update. Asking for human
         * updates of tickets directly is 314 rows in under a second. Bounded
         * by the window's start, less a day of slack: a ticket in the window
         * was created at or after its complaint, so it cannot have been edited
         * before the window opened — and the bound keeps this query from
         * growing with every edit ever made.
         */
        needs.breakdown
          ? attempt(
              () =>
                directus.request(
                  readRevisions({
                    limit: -1,
                    filter: {
                      collection: { _eq: 'tickets' },
                      activity: {
                        action: { _eq: 'update' },
                        user: { _nnull: true },
                        timestamp: {
                          _gte: new Date(new Date(since).getTime() - DAY_MS).toISOString(),
                        },
                      },
                    },
                    fields: ['item', 'activity.action', 'activity.timestamp', 'activity.user'],
                    // Newest first, so the first row seen for a ticket wins.
                    sort: ['-id'],
                  } as never),
                ) as Promise<RawRevision[]>,
              (err: unknown) => {
                /*
                 * Still best-effort — no audit read may empty the whole report —
                 * but NOT silent. This catch once swallowed a 403 for weeks and
                 * the only symptom was two permanently blank columns, which reads
                 * as "nobody edited these tickets" rather than as a failure.
                 */
                console.warn('[report] last-modified lookup failed; columns will be blank:', err);
                return [] as RawRevision[];
              },
            )
          : Promise.resolve([] as RawRevision[]),
        /*
         * What this window is LEAVING OUT — tickets logged in it, dated
         * outside. A COUNT with its first and last date, asked of the server:
         * it used to download every such row (7,646 on the import day) to
         * count them in the browser. Best-effort: a count that fails must not
         * cost anyone their rows.
         */
        needs.breakdown
          ? attempt(
              () =>
                directus.request(
                  aggregate(
                    'tickets' as never,
                    {
                      aggregate: { count: '*', min: 'complaint_date', max: 'complaint_date' },
                      query: {
                        filter: {
                          _and: [
                            inRange('date_created'),
                            { complaint_date: { _nnull: true } },
                            {
                              // "Outside" needs both edges to mean anything. With
                              // no end date the window runs to now, so only the
                              // earlier edge can exclude a ticket.
                              _or: until
                                ? [
                                    { complaint_date: { _lt: since } },
                                    { complaint_date: { _gt: until } },
                                  ]
                                : [{ complaint_date: { _lt: since } }],
                            },
                          ],
                        },
                      },
                    } as never,
                  ),
                ) as unknown as Promise<
                  Array<{
                    count?: unknown;
                    min?: { complaint_date?: string | null };
                    max?: { complaint_date?: string | null };
                  }>
                >,
              () => null,
            )
          : Promise.resolve(null),
      ]);

      // Service accounts (…@svc.…) aren't people — exclude them so they never
      // surface as real agents or inflate the Agent KPI (same rule as useAgents).
      const isSvc = (email: string | null) => (email ?? '').toLowerCase().includes('@svc.');
      const svcIds = new Set(users.filter((u) => isSvc(u.email)).map((u) => u.id));
      const userName = new Map(
        users.filter((u) => !isSvc(u.email)).map((u) => [u.id, displayName(u)]),
      );
      const agentOf = (id: string | null) => (id ? (userName.get(id) ?? '—') : labels.unassigned);
      /** Fold service-account assignments into the "unassigned" row for the KPI. */
      const realAgentId = (id: string | null): string | null => (id && svcIds.has(id) ? null : id);

      // CSAT → agent, via the rated conversation's assigned agent. Conversations
      // created BEFORE the window aren't in `conversations`, so an in-window CSAT
      // for such a conversation would resolve to no agent. Fetch the assigned
      // agent for those referenced-but-missing conversations so every in-window
      // CSAT is attributed regardless of when its conversation was created.
      const convAgent = new Map<string, string | null>(
        conversations.map((c) => [c.id, c.assigned_agent]),
      );
      const missingConvIds = Array.from(
        new Set(
          csat.map((r) => r.conversation).filter((id): id is string => !!id && !convAgent.has(id)),
        ),
      );
      /*
       * The second and last batch: both need the conversations above, and
       * neither needs the other, so they run side by side — and the message
       * chunks four at a time. A month of chats is a handful of chunks; in
       * series each one was a full round trip of waiting (2026-10-05).
       */
      const [extraConvs, chatMsgs] = await Promise.all([
        missingConvIds.length > 0
          ? readByIdsChunked<{ id: string; assigned_agent: string | null }>(
              'conversations',
              missingConvIds,
              (ids) => ({
                filter: { id: { _in: ids } },
                fields: ['id', 'assigned_agent'],
                limit: -1,
              }),
            )
          : Promise.resolve([] as Array<{ id: string; assigned_agent: string | null }>),
        // The operational half the owner evaluates agents BY — chats handled,
        // no-reply, in-time %, first response, time to solve, common chats —
        // computed with the exact shared arithmetic of the performance pages.
        // Chunked: one `_in` carrying every conversation id overflows the URL and
        // CloudFront answers 414 before Directus sees it. See IN_FILTER_CHUNK.
        readByIdsChunked<{
          conversation: string;
          sender_type: string;
          date_created: string | null;
          sender_user: string | null;
        }>(
          'messages',
          conversations.map((c) => c.id),
          (ids) => ({
            limit: -1,
            filter: {
              conversation: { _in: ids },
              is_internal_note: { _eq: false },
            },
            /* `sender_user` so a reply is credited to the agent who SENT it. The
               ladder moves chats, so `assigned_agent` is who holds it now, which is
               frequently not who answered. */
            fields: ['conversation', 'sender_type', 'date_created', 'sender_user'],
            sort: ['date_created'],
          }),
          4,
        ),
      ]);
      for (const c of extraConvs) convAgent.set(c.id, c.assigned_agent);

      /* Report 1: tickets + SLA timings (order enrichment added later). */
      // Not for the breakdown: it never shows these, and its leaner field list
      // does not carry the SLA stamps they are built from.
      const ticketRows: TicketReportRow[] = (kind === 'complaints' ? [] : tickets).map((t) => ({
        id: t.id,
        subject: t.subject || labels.noSubject,
        /* Normalised (owner, 2026-10-07: two ticket states, pending and
           solved). The status chips, the pill and the export all read this
           field, and the stored value on imported history is `closed`. */
        status: normaliseTicketStatus(t.status),
        priority: t.priority,
        contactId: t.contact?.id ?? null,
        /* THROUGH `displayContactName` (owner, 2026-10-05: "the customer name
           by default is +966508315325... i need it to be with 05"). The agent
           portal was fixed on 10-05 and the ADMIN portal was missed — eight
           raw `contact?.name` reads here, so the same customer read `+966…` in
           one portal and `05…` in the other. */
        contactName: displayContactName(t.contact?.name, t.contact?.phone),
        contactEmail: t.contact?.email ?? '',
        contactPhone: t.contact?.phone ?? '',
        agentName: agentOf(t.assigned_agent),
        createdAt: t.date_created,
        firstResponseMinutes: minutesBetween(t.date_created, t.first_responded_at),
        firstResponseState: slaOutcome(t.first_response_due_at, t.first_responded_at, now),
        resolutionMinutes: minutesBetween(t.date_created, t.resolved_at),
        resolutionState: slaOutcome(t.resolution_due_at, t.resolved_at, now),
        storeSnapshot: t.store_snapshot ?? null,
      }));

      /* Report 4: the operations complaints report. The store-derived columns
       * are filled in by the page, which owns the store index; here we carry
       * the raw order snapshot values through so the join has something to
       * match on. */
      /**
       * Ordered by WHEN THE COMPLAINT HAPPENED — the date this report shows.
       *
       * Directus sorts by date_created, and an imported batch shares one
       * creation stamp: 51 tickets landed with the same date_created, so the
       * three genuinely newest complaints sat at rows 51-53 while page 1 showed
       * July. Sorting on a field the table does not display is a sort nobody
       * can see is wrong. The export inherits this order too.
       */
      const byWhen = [...tickets].sort((a, b) =>
        String(b.complaint_date ?? b.date_created ?? '').localeCompare(
          String(a.complaint_date ?? a.date_created ?? ''),
        ),
      );
      /*
       * Who last edited each ticket, and when — from the AUDIT TRAIL, not from
       * `user_updated`.
       *
       * `user_updated` is Directus's own stamp and it is correct, but it
       * records the LAST writer of any kind. Background jobs write to tickets
       * routinely (the SLA sweep stamps due dates, the gateway stamps first
       * response), and a server-side write carries no accountability — so it
       * lands as NULL and erases whichever human edited the row before it.
       * Every ticket in this database showed a `date_updated` with a null
       * `user_updated` for exactly that reason, which made the column read as
       * "nobody edited this" when somebody had.
       *
       * Revisions keep every write with its actor, so the last revision whose
       * activity has a real user IS the last human edit. Read in the first
       * batch above, best-effort: no audit read must ever empty the report.
       */
      /*
       * COMPENSATION, RESOLVED FROM THE COUPON.
       *
       * Two lookups because the link is only now being written:
       *
       *   by TICKET  the coupon says which ticket it answers. Authoritative:
       *              two tickets can be about one order, and only this says
       *              which of them the money was for.
       *   by ORDER   the fallback. Every coupon raised before 2026-09-29 has
       *              `ticket: null` (the late-order path hardcoded it), so
       *              without this the fix would not reach a single existing
       *              row.
       *
       * A REJECTED coupon is NOT compensation — it was asked for and refused,
       * and reporting it as compensated would overstate what the customer
       * received. Anything else that reached the queue counts: pending is
       * money already committed by an agent, and `assigned` / `edited` are
       * both approvals.
       */
      const compensatedTickets = new Set<string>();
      const compensatedOrders = new Set<string>();
      for (const c of coupons) {
        if ((c.status ?? '').toLowerCase() === 'rejected') continue;
        if (c.ticket) compensatedTickets.add(String(c.ticket));
        const order = c.order_id?.trim();
        if (order) compensatedOrders.add(order);
      }
      /* The ticket's OWN column still wins when it is set: the ticket form
         writes it directly, and that is a statement by the agent about this
         ticket rather than an inference from a related row. */
      const compensationOf = (t: RawTicket): string => {
        const own = t.compensation?.trim();
        if (own) return own;
        const order = t.order_id?.trim();
        if (compensatedTickets.has(t.id) || (order && compensatedOrders.has(order))) {
          /* The SHARED helper, not a literal: this exact spelling is what the
             ticket form writes and what the report's filters match on. */
          return compensationFlag(true);
        }
        return '';
      };

      const lastEditBy = new Map<string, { name: string; at: string }>();
      for (const r of revisions) {
        // The query already asked for human updates only; kept as a guard so a
        // looser server-side filter can never credit a system write.
        if (!r.activity?.user || r.activity.action !== 'update') continue;
        const item = String(r.item);
        if (lastEditBy.has(item)) continue;
        const name = userName.get(r.activity.user);
        if (!name) continue; // service accounts are not people
        lastEditBy.set(item, { name, at: fmtStamp(r.activity.timestamp) });
      }

      const complaintRows: ComplaintReportRow[] = byWhen.map((t) => {
        // When it HAPPENED, not when it was typed in. Older tickets have no
        // complaint_date and keep dating from creation.
        const when = splitLocalDateTime(t.complaint_date ?? t.date_created);
        const snap = t.order_snapshot ?? null;
        return {
          id: t.id,
          ...when,
          // Filled by the store join on the page; blank here rather than
          // guessed, so an unjoined row is visibly unjoined.
          chain: '',
          area: '',
          brand: snap?.brandName?.trim() ?? '',
          city: '',
          restaurantName: snap?.restaurantName?.trim() ?? '',
          // Filled by the store join; blank until then.
          storeCode: '',
          yijiRestaurantId: '',
          storeMapped: false,
          serviceType: t.service_type ?? '',
          complaintType: t.complaint_type ?? '',
          customerName: displayContactName(t.contact?.name, t.contact?.phone),
          customerMobile: t.contact?.phone ?? '',
          complaintDescription: t.description ?? '',
          responseDesc: t.response_desc ?? '',
          complaintSource: t.complaint_source ?? '',
          orderAmount: toNumber(snap?.total),
          /* The same fault as the agent portal's: `order_id` was FETCHED here
             (it is in the field list above) and then ignored, so a ticket with
             no `order_snapshot` reported no order number. The column first. */
          orderNumber: String(t.order_id ?? snap?.orderId ?? ''),
          communicationMethod: t.communication_method ?? '',
          couponCode: t.coupon_code ?? '',
          couponValue: toNumber(t.coupon_value),
          couponPercent: toNumber(t.coupon_percent),
          /*
           * THE LIVE VOCABULARY, not whatever the row happens to store.
           *
           * Ticket status is `pending | solved` (owner, 2026-10-07); `open`,
           * `new`, `resolved` and `closed` are retired names still carried by 1,671 imported rows, which are
           * deliberately never rewritten. Every reader is supposed to go
           * through the normaliser so that a stored `closed` and a stored
           * `solved` read the same — this report did not, so the status column
           * reported the database's history rather than the ticket's state
           * (owner, 2026-09-16).
           */
          complaintStatus: normaliseTicketStatus(t.status),
          agent: agentOf(t.assigned_agent),
          compensation: compensationOf(t),
          // Blank until the first edit — a creation is not a modification, and
          // a column of creation timestamps would drown the real signal.
          lastModifiedBy: lastEditBy.get(t.id)?.name ?? '',
          lastModifiedAt: lastEditBy.get(t.id)?.at ?? '',
          storeSnapshot: t.store_snapshot ?? null,
        };
      });

      /* Report 2: agent KPI — tickets per agent + CSAT. */
      interface Acc {
        agentId: string | null;
        agentName: string;
        tickets: number;
        csatSum: number;
        csatCount: number;
      }
      const accs = new Map<string, Acc>();
      const ensure = (id: string | null, name: string): Acc => {
        const key = id ?? '__unassigned__';
        let a = accs.get(key);
        if (!a) {
          a = { agentId: id, agentName: name, tickets: 0, csatSum: 0, csatCount: 0 };
          accs.set(key, a);
        }
        return a;
      };

      /* From the rows when they were fetched anyway, from the server's grouped
         count when they were not — never both (one or the other is empty). */
      for (const t of tickets) {
        const agentId = realAgentId(t.assigned_agent);
        ensure(agentId, agentOf(agentId)).tickets += 1;
      }
      for (const [assigned, n] of ticketCounts) {
        const agentId = realAgentId(assigned);
        ensure(agentId, agentOf(agentId)).tickets += n;
      }

      let csatOverallSum = 0;
      let csatOverallCount = 0;
      for (const r of csat) {
        if (typeof r.score !== 'number') continue;
        csatOverallSum += r.score;
        csatOverallCount += 1;
        // Attribute to the conversation's assigned agent regardless of when the
        // conversation was created (convAgent now includes the missing ones).
        // Unassigned conversations and service-account assignments fold into the
        // "unassigned" row, so sum(per-agent csatCount) === csatOverall.count.
        const agentId = realAgentId(
          r.conversation ? (convAgent.get(r.conversation) ?? null) : null,
        );
        const a = ensure(agentId, agentOf(agentId));
        a.csatSum += r.score;
        a.csatCount += 1;
      }

      // Auto-assignment outcomes + handoffs. One read serves both: the
      // missed/offered tallies, and chatHandoffs' "who really carried the
      // wait" verdict that the performance pages use.
      const missedBy = new Map<string, number>();
      const offeredBy = new Map<string, number>();
      for (const e of routingEvents) {
        if (!e.agent) continue;
        offeredBy.set(e.agent, (offeredBy.get(e.agent) ?? 0) + 1);
        if (e.outcome === 'missed') missedBy.set(e.agent, (missedBy.get(e.agent) ?? 0) + 1);
      }
      const handoffs = chatHandoffs(routingEvents);

      const chatTimes = conversationTimestamps(chatMsgs);
      const timings = conversations.map((c) => {
        const agentId = realAgentId(c.assigned_agent);
        return {
          conversationId: c.id,
          agentId,
          agentName: agentOf(agentId),
          firstCustomerAt: chatTimes.get(c.id)?.firstCustomerAt ?? null,
          firstAgentAt: chatTimes.get(c.id)?.firstAgentAt ?? null,
          firstAgentBy: realAgentId(chatTimes.get(c.id)?.firstAgentBy ?? null),
          solvedAt: normaliseConversationStatus(c.status) === 'solved' ? c.solved_at : null,
          passedOn: handoffs.get(c.id)?.passedOn ?? false,
          takenBy: handoffs.get(c.id)?.takenBy ?? null,
          // Agent-started chats: measured from the customer's reply, and one
          // never answered is not "not replied" (owner, 2026-10-07).
          initiatedBy: c.initiated_by === 'agent' ? ('agent' as const) : ('customer' as const),
          firstOutreachAt: chatTimes.get(c.id)?.firstAgentAnyAt ?? null,
        };
      });
      const perfRows = new Map(agentPerformance(timings).map((r) => [r.agentId ?? '', r]));

      /*
       * Answered-in-time, against the same 5-minute default target the
       * performance pages open with.
       *
       * CREDITED TO THE AGENT WHO REPLIED, and no longer skipping chats the
       * ladder passed on. That skip is why this column was BLANK on production:
       * every chat there is broadcast or escalated, so `passedOn` was true for
       * all 46 of 46 conversations and the map came out empty (owner-reported,
       * 2026-09-30). Keyed the same way as `agentPerformance` above, so the two
       * columns describe the same population — a percentage beside an average of
       * a different set of chats is worse than no percentage.
       */
      /*
       * ONE POPULATION WITH THE FIRST-RESPONSE COLUMN (2026-10-05).
       *
       * Two drifts from `agentPerformance` remained. This tally credited
       * `firstAgentBy ?? agentId` while the timing credited
       * `firstAgentBy ?? takenBy ?? agentId`, so a chat picked up off the ladder
       * by an agent whose reply had no `sender_user` counted toward its
       * ASSIGNEE's percentage and its TAKER's time. And a negative wait (clock
       * skew, a repaired row) stayed in the denominator as a miss here while
       * the timing discarded it as no measurement. Both now follow the shared
       * rule: `firstResponseSec` drops the unmeasurable, and the key is the
       * same responder chain.
       */
      const TARGET_SEC = 5 * 60;
      const inTime = new Map<string, { answered: number; inTime: number }>();
      for (const c of timings) {
        const sec = firstResponseSec(c);
        if (sec === null) continue;
        const key = c.firstAgentBy ?? c.takenBy ?? c.agentId ?? '';
        const t = inTime.get(key) ?? { answered: 0, inTime: 0 };
        t.answered += 1;
        if (sec <= TARGET_SEC) t.inTime += 1;
        inTime.set(key, t);
      }

      // Union of the ticket-side and chat-side agents: someone who only chats
      // (or only handles tickets) still gets a full row.
      for (const key of perfRows.keys()) {
        const id = key === '' ? null : key;
        ensure(id, agentOf(id));
      }

      const agents: AgentKpiRow[] = Array.from(accs.values())
        .map((a) => {
          const perf = perfRows.get(a.agentId ?? '');
          const it = inTime.get(a.agentId ?? '');
          return {
            agentId: a.agentId,
            agentName: a.agentName,
            tickets: a.tickets,
            csatCount: a.csatCount,
            csatAvg: a.csatCount ? a.csatSum / a.csatCount : null,
            missed: missedBy.get(a.agentId ?? '') ?? 0,
            offered: offeredBy.get(a.agentId ?? '') ?? 0,
            chats: perf?.chats ?? 0,
            noReply: perf?.unanswered ?? 0,
            commonTaken: perf?.commonChats ?? 0,
            ...(() => {
              const o = agentInitiatedSummary(
                timings.filter((x) => (x.agentId ?? '') === (a.agentId ?? '')),
              );
              return { agentStarted: o.started, agentStartedReplied: o.customerReplied };
            })(),
            medianFirstResponseSec: perf?.medianFirstResponseSec ?? null,
            avgTimeToSolveSec: perf?.avgTimeToSolveSec ?? null,
            inTimePct: it && it.answered > 0 ? (it.inTime / it.answered) * 100 : null,
          };
        })
        .sort(
          (x, y) =>
            y.chats - x.chats || y.tickets - x.tickets || x.agentName.localeCompare(y.agentName),
        );

      /* Report 3: conversations by status / priority / day. */
      const byStatusMap = new Map<string, number>();
      const byPriorityMap = new Map<string, number>();
      const byDayMap = new Map<string, DayStatusCount>();
      const statusSet = new Set<string>();
      const convRows: ConversationRow[] = conversations.map((c) => {
        byStatusMap.set(c.status, (byStatusMap.get(c.status) ?? 0) + 1);
        byPriorityMap.set(c.priority, (byPriorityMap.get(c.priority) ?? 0) + 1);
        statusSet.add(c.status);
        const day = (c.date_created ?? '').slice(0, 10);
        if (day) {
          let d = byDayMap.get(day);
          if (!d) {
            d = { day, total: 0, byStatus: {} };
            byDayMap.set(day, d);
          }
          d.total += 1;
          d.byStatus[c.status] = (d.byStatus[c.status] ?? 0) + 1;
        }
        const times = chatTimes.get(c.id);
        // Solved chats are not waiting on anybody, however the messages fell.
        const awaitingReply =
          c.status !== 'solved' && !!times?.firstCustomerAt && !times?.firstAgentAt;
        return {
          id: c.id,
          status: c.status,
          priority: c.priority,
          agentName: agentOf(c.assigned_agent),
          createdAt: c.date_created,
          lastMessageAt: c.last_message_at,
          /* `displayContactName` already falls back to the phone when there is
             no usable name, so the old `|| phone` chain is folded into it —
             two fallback rules in two places is how they drift apart. */
          customerName: displayContactName(c.contact?.name, c.contact?.phone),
          customerPhone: c.contact?.phone ?? '',
          customerEmail: c.contact?.email ?? '',
          orderId: c.last_order_id ?? '',
          awaitingReply,
          startedBy: c.initiated_by === 'agent' ? 'agent' : 'customer',
          waitingMinutes:
            awaitingReply && times?.firstCustomerAt
              ? Math.max(0, Math.round((now - new Date(times.firstCustomerAt).getTime()) / 60000))
              : null,
        };
      });

      const conversationsReport: ConversationStatusReport = {
        rows: convRows,
        byStatus: Array.from(byStatusMap.entries())
          .map(([key, count]) => ({ key, count }))
          .sort((a, b) => b.count - a.count),
        byPriority: Array.from(byPriorityMap.entries())
          .map(([key, count]) => ({ key, count }))
          .sort((a, b) => b.count - a.count),
        byDay: Array.from(byDayMap.values()).sort((a, b) => a.day.localeCompare(b.day)),
        statuses: Array.from(statusSet).sort(),
        total: conversations.length,
      };

      /* What this window is LEAVING OUT — counted in the first batch. Null
         when the count failed or found nothing: the report stands on its own
         rows. */
      const outsideRow = outside?.[0];
      const outsideCount = countOf(outsideRow?.count);
      const loggedOutsideWindow: AgentReportData['loggedOutsideWindow'] =
        outsideCount > 0
          ? {
              count: outsideCount,
              earliest: String(outsideRow?.min?.complaint_date ?? '').slice(0, 10),
              latest: String(outsideRow?.max?.complaint_date ?? '').slice(0, 10),
            }
          : null;

      return {
        tickets: ticketRows,
        complaints: complaintRows,
        complaintFieldsAvailable,
        loggedOutsideWindow,
        agents,
        conversations: conversationsReport,
        csatOverall: {
          avg: csatOverallCount ? csatOverallSum / csatOverallCount : null,
          count: csatOverallCount,
        },
        generatedAt: new Date().toISOString(),
      };
    }
  }
}

/* ── Order enrichment (commerce proxy, bounded + best-effort) ─────────── */

interface ContactCommerce {
  id: string;
  external_customer_id: string | null;
  vendor: { yiji_vendor_id: string | null } | null;
}

/** How many distinct customers we enrich with live order data per run. Bounds
 *  the load on the Yiji proxy; tickets beyond this simply export without order
 *  columns rather than stalling the whole report. */
const MAX_ENRICHED_CONTACTS = 150;
/** Concurrent commerce requests — the proxy is a shared external dependency. */
const ORDER_CONCURRENCY = 5;

async function pool<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

function summariseItems(items: { qty: number; name: string }[]): string {
  return items
    .map((it) => `${it.qty}× ${it.name}`)
    .join('; ')
    .slice(0, 2000);
}

/** `in_delivery` → `In Delivery`. */
function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Brand + branch, e.g. "La Casa Pasta — Riyadh - Masief Plaza". */
function restaurantLabel(o: {
  brandName?: string;
  restaurantName?: string;
  restaurantId?: string;
}): string {
  const parts = [o.brandName, o.restaurantName].filter(Boolean) as string[];
  if (parts.length) return parts.join(' — ');
  return o.restaurantId ? `#${o.restaurantId}` : '';
}

/**
 * Enrich ticket rows with each customer's latest Yiji order. Runs only when the
 * caller opts in (the export includes order columns), fetches at most one order
 * per unique contact, caps the number of contacts, and swallows every per-request
 * error so a partial/absent commerce layer degrades to blank order cells.
 *
 * Returns a Map<contactId, TicketOrderInfo|null>; `null` means "looked up, none".
 */
export function useTicketOrders(contactIds: string[], enabled: boolean, days: number) {
  // Stable, de-duplicated key so the enrichment is cached per report window.
  const uniqueIds = Array.from(new Set(contactIds.filter(Boolean)));
  return useQuery({
    enabled: enabled && uniqueIds.length > 0,
    staleTime: 60_000,
    queryKey: ['agent-report-orders', days, uniqueIds.length, uniqueIds.slice(0, 50).join(',')],
    queryFn: async (): Promise<Map<string, TicketOrderInfo | null>> => {
      const result = new Map<string, TicketOrderInfo | null>();
      const capped = uniqueIds.slice(0, MAX_ENRICHED_CONTACTS);
      if (capped.length === 0) return result;

      // Resolve the commerce ids (external_customer_id + vendor.yiji_vendor_id)
      // for just these contacts in one query.
      let contacts: ContactCommerce[] = [];
      try {
        // Chunked for the same reason as the report queries: 150 ids is already
        // a ~5.5KB filter, and the cap is a product decision that could rise.
        contacts = await readByIdsChunked<ContactCommerce>('contacts', capped, (ids) => ({
          filter: { id: { _in: ids } },
          fields: ['id', 'external_customer_id', 'vendor.yiji_vendor_id'],
          limit: -1,
        }));
      } catch {
        // Contacts unreadable → no enrichment, blank order columns.
        return result;
      }

      const linkable = contacts.filter((c) => c.external_customer_id && c.vendor?.yiji_vendor_id);

      await pool(linkable, ORDER_CONCURRENCY, async (c) => {
        try {
          const vendorId = c.vendor!.yiji_vendor_id as string;
          // The list endpoint is a SUMMARY (id/status/total/date only) — the
          // restaurant, brand, items and delivery type live on the single-order
          // endpoint, so fetch the latest id from the list, then its full detail.
          const orders = await commerce.getOrders(vendorId, c.external_customer_id as string, {
            limit: 1,
          });
          const summary = orders?.[0];
          if (!summary) {
            result.set(c.id, null);
            return;
          }
          let full = null;
          try {
            full = await commerce.getOrder(vendorId, summary.orderId);
          } catch {
            /* detail unavailable — fall back to the sparse summary */
          }
          const o = full ?? summary;
          result.set(c.id, {
            orderId: o.orderId,
            restaurant: restaurantLabel(o),
            status: o.status ?? '',
            delivery: o.deliveryType ? titleize(o.deliveryType) : (o.deliveryAddress ?? ''),
            items: summariseItems(o.items ?? []),
            total: typeof o.total === 'number' ? o.total : null,
            currency: o.currency ?? '',
            // Untouched originals for the store match. Yiji ships brandName
            // with a leading space, so nothing here is pre-trimmed on purpose —
            // the matcher owns normalisation.
            rawBrandName: o.brandName ?? undefined,
            rawRestaurantName: o.restaurantName ?? undefined,
            rawRestaurantId: o.restaurantId ?? undefined,
          });
        } catch {
          // Leave this contact absent from the map → blank order columns.
        }
      });

      return result;
    },
  });
}
