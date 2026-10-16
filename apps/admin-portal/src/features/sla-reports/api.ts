import { useQuery } from '@tanstack/react-query';
import { readItems, readUsers } from '@directus/sdk';
import {
  businessSecondsBetween,
  normaliseTicketStatus,
  parseBusinessHours,
  slaHoursByGoverns,
  type SlaHoursByObject,
  type VendorRef,
} from '@yiji/shared-types';
import { ticketSolveSec, ticketSolveSpan } from '@yiji/reports';
import { directus } from '../../lib/directus.js';
import { NO_SLA_HOURS } from '../../lib/sla-hours.js';
import { useReportVendorFilter, withVendor } from '../../lib/report-vendor.js';
import { loadTicketSolveContext } from '../../lib/ticket-solve.js';
import { governingPolicy, type ReportSlaPolicy } from './ticket-timing.js';

/**
 * SLA reports — interactive, drill-down analytics over ticket SLA performance,
 * computed client-side from the collections the admin can already read (same
 * approach as the dashboard; no worker round-trip, so it filters live).
 *
 * Two cuts of the same data:
 *   - per AGENT  → compliance + breaches grouped by assigned agent (drill into
 *                  an agent to see their tickets), and
 *   - per TICKET → every ticket with its first-response + resolution SLA state.
 *
 * "Met vs breached" is judged from the ticket's own SLA timestamps:
 *   resolution: resolved_at vs resolution_due_at
 *
 * FIRST RESPONSE IS NOT A TICKET MEASURE HERE, and the headline reads it from
 * the CHATS instead. A ticket is raised out of a conversation an agent has
 * already answered, so a first response timed from the ticket's creation
 * re-judges a reply made before the ticket existed. The columns are still on
 * the ticket and are now always null; reading them produced a tile that showed
 * a confident percentage of nothing. The promise to answer is measured where it
 * is kept — see `conversations.first_response_due_at`.
 */

export type SlaState = 'met' | 'breached' | 'pending' | 'na';

export interface SlaCell {
  state: SlaState;
  dueAt: string | null;
  doneAt: string | null;
  /**
   * Where a resolution verdict came from: the deadline the SLA sweep stamped
   * (`deadline`), or — for a ticket solved before the once-a-minute sweep ever
   * saw it, so no deadline was stamped — the policy that governs it, judged on
   * the time it actually took (`policy`). Absent on the first-response cell.
   */
  source?: 'deadline' | 'policy';
  /** The governing policy's name, when the verdict was judged against it. */
  policyName?: string | null;
  /**
   * Why an `na` cell has no verdict: no active policy covers the ticket (or it
   * was raised before the policy existed), or it is solved with no solve time
   * anywhere (the imported history).
   */
  naReason?: 'noPolicy' | 'noSolveTime';
}

export interface TicketSla {
  id: string;
  subject: string;
  priority: string;
  status: string;
  agentId: string | null;
  agentName: string;
  created: string | null;
  firstResponse: SlaCell;
  resolution: SlaCell;
  /**
   * WORKING minutes from creation to first response (null if not yet
   * responded) — the ticket policy's business hours, as the SLA engine counts
   * them (owner, 2026-10-08). Wall clock when the policy has none.
   */
  responseMinutes: number | null;
  /**
   * Where the 1st reply came from: the CHAT session the ticket was raised from
   * (customer's first message -> first human agent reply, the same rule as the
   * Agent summary), or the ticket's own first-action stamp when it has no chat.
   * Null when there is no reply to measure.
   */
  replySource: 'chat' | 'ticket' | null;
  /**
   * WORKING minutes from raising the ticket to solving it — shown whether or
   * not a deadline was stamped. Null when it is not solved, or solved with no
   * solve time recorded.
   */
  solveMinutes: number | null;
  /**
   * How `solveMinutes` was measured (`ticketSolveSpan`): from the customer's
   * first chat message (`chat`) or the ticket's creation (`ticket`); `server`
   * when the end is the server's solve record; `instant` when it was solved
   * the moment it was raised.
   */
  solveBasis: 'chat' | 'ticket' | 'server' | 'instant' | null;
}

export interface AgentSla {
  agentId: string | null;
  agentName: string;
  tickets: number;
  frMet: number;
  frBreached: number;
  frPending: number;
  /** First-response compliance % over decided (met+breached) tickets. */
  frPct: number | null;
  resMet: number;
  resBreached: number;
  resPending: number;
  resPct: number | null;
  avgResponseMin: number | null;
  /** First-response + resolution breaches. */
  breaches: number;
}

export interface SlaReport {
  tickets: TicketSla[];
  agents: AgentSla[];
  totals: {
    tickets: number;
    /**
     * Chat first-response compliance over the same window — how often an agent
     * answered a customer inside the target, judged on the conversations.
     * Null when no chat in the range had a first-response clock at all, which
     * the tile must say out loud rather than render as 0%.
     */
    frPct: number | null;
    /** How many chats that percentage is computed over, so the tile can say. */
    frChats: number;
    resPct: number | null;
    breaches: number;
  };
}

interface RawTicket {
  id: string;
  subject: string | null;
  status: string;
  priority: string;
  assigned_agent: string | null;
  date_created: string | null;
  first_response_due_at: string | null;
  first_responded_at: string | null;
  resolution_due_at: string | null;
  resolved_at: string | null;
  complaint_date?: string | null;
  conversation?: string | null;
  complaint_type?: string | null;
  complaint_source?: string | null;
  store_snapshot?: { brandName?: string | null } | null;
  vendor?: VendorRef;
}

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
];

/* What the fallbacks need: the complaint time (the solve stamp's own clock), the
   chat the ticket came from, and the facts a policy narrows by. */
const FULL_TICKET_FIELDS = [
  ...BASE_TICKET_FIELDS,
  'complaint_date',
  'conversation',
  'complaint_type',
  'complaint_source',
  'store_snapshot',
  'vendor',
];

type PolicyRow = ReportSlaPolicy & { business_hours?: unknown };

/**
 * Every SLA policy, once: the working hours the durations are counted in AND
 * the coverage a ticket with no stamped deadline is judged against. Never
 * throws — a failed read is the wall clock and no fallback verdicts, i.e. the
 * old report.
 */
async function loadPolicies(): Promise<{ policies: PolicyRow[]; hours: SlaHoursByObject }> {
  const base = [
    'id',
    'name',
    'governs',
    'active',
    'business_hours',
    'applies_to_priority',
    'applies_to_type',
    'applies_to_source',
    'applies_to_brand',
    'resolution_minutes',
    'date_created',
  ];
  const read = (fields: string[]) =>
    directus.request(
      readItems('sla_policies' as never, { fields, limit: -1 } as never),
    ) as unknown as Promise<PolicyRow[]>;
  try {
    // The vendor column is an MV-1 field that may not exist yet; ask, else not.
    const policies = await read([...base, 'vendor']).catch(() => read(base));
    return { policies: policies ?? [], hours: slaHoursByGoverns(policies ?? []) };
  } catch (err) {
    console.warn('[sla-reports] could not read sla_policies; wall clock, no policy fallback:', err);
    return { policies: [], hours: NO_SLA_HOURS };
  }
}

/** Classify one SLA dimension: done-in-time / done-late / overdue / on-track / no-target. */
function classify(dueAt: string | null, doneAt: string | null, now: number): SlaCell {
  if (!dueAt) return { state: 'na', dueAt, doneAt };
  if (doneAt) {
    const met = new Date(doneAt).getTime() <= new Date(dueAt).getTime();
    return { state: met ? 'met' : 'breached', dueAt, doneAt };
  }
  return { state: new Date(dueAt).getTime() < now ? 'breached' : 'pending', dueAt, doneAt: null };
}

/**
 * @param days   rolling window, used when no explicit dates are given.
 * @param range  explicit `from`/`to` (yyyy-mm-dd). Wins over `days` — a person
 *               who has typed two dates has asked a more specific question than
 *               "the last 30 days", and answering the vaguer one would ignore
 *               what they typed.
 */
export function useSlaReports(days: number, range?: { from?: string; to?: string }) {
  const from = range?.from?.trim() || '';
  const to = range?.to?.trim() || '';
  /* The shared report vendor filter (MV-4); '' = every vendor, always so with one. */
  const vendor = useReportVendorFilter();
  return useQuery({
    queryKey: ['sla-reports', days, from, to, vendor],
    staleTime: 60_000,
    queryFn: async (): Promise<SlaReport> => {
      const since = from
        ? `${from}T00:00:00`
        : new Date(Date.now() - days * 86_400_000).toISOString();
      const now = Date.now();
      // Inclusive `to`: a range ending on the 31st contains the 31st.
      const dateFilter: Record<string, unknown> = { _gte: since };
      if (to) dateFilter._lte = `${to}T23:59:59`;

      const readTickets = (filter: unknown, fields: string[]) =>
        directus.request(
          readItems('tickets', {
            filter: filter as never,
            fields: fields as never,
            limit: -1,
            sort: ['-date_created'],
          }),
        ) as Promise<RawTicket[]>;

      const [tickets, chats, users, { policies, hours: slaHours }] = await Promise.all([
        /*
         * WHEN THE COMPLAINT HAPPENED, falling back to creation — the same
         * window the ticket breakdown uses (owner, 2026-10-05).
         *
         * This filtered `date_created` alone, and on 2026-10-05 7,912 historical
         * tickets were imported in one go, every one stamped with that day. The
         * default 30-day window then returned all 7,987 tickets: nine months of
         * history counted as "this month". `complaint_date` is when the ticket
         * is about; tickets raised before that field existed have none, and the
         * `_and` branch keeps them dated from creation instead of dropping them.
         *
         * A Directus without the complaint schema rejects the whole query for
         * the unknown field, so it falls back to the old creation-date window
         * rather than taking the SLA page down.
         */
        readTickets(
          withVendor(
            {
              _or: [
                { complaint_date: dateFilter },
                { _and: [{ complaint_date: { _null: true } }, { date_created: dateFilter }] },
              ],
            },
            vendor,
          ),
          FULL_TICKET_FIELDS,
        ).catch(() =>
          readTickets(withVendor({ date_created: dateFilter }, vendor), BASE_TICKET_FIELDS),
        ),
        /*
         * The chats whose first-response promise falls in this window.
         *
         * Only those with a deadline: a conversation that started before the
         * chat policy was written was never promised anything, and folding it
         * in as "not met" would report a failure that never happened. Filtered
         * in the query so the count and the percentage are computed over the
         * same set.
         */
        directus.request(
          readItems('conversations', {
            filter: withVendor(
              { date_created: dateFilter, first_response_due_at: { _nnull: true } },
              vendor,
            ) as never,
            fields: ['id', 'first_response_due_at', 'first_responded_at'],
            limit: -1,
          }),
        ) as Promise<
          Array<{
            id: string;
            first_response_due_at: string | null;
            first_responded_at: string | null;
          }>
        >,
        directus.request(
          readUsers({ fields: ['id', 'first_name', 'last_name', 'email'], limit: -1 }),
        ) as Promise<
          Array<{
            id: string;
            first_name: string | null;
            last_name: string | null;
            email: string | null;
          }>
        >,
        // Never throws: null hours = the wall clock, the old numbers.
        loadPolicies(),
      ]);

      /*
       * The chat session each ticket was raised from (first customer message,
       * first HUMAN reply) and, for the few whose browser `resolved_at` is
       * missing or behind, the server's own solve time — read once, the same
       * inputs the Agent summary feeds the shared rule (`ticketSolveSec`).
       * Best-effort: a failed read is the ticket's own stamps.
       */
      const solveCtx = await loadTicketSolveContext(
        tickets.map((t) => ({
          id: t.id,
          status: t.status,
          date_created: t.date_created,
          resolved_at: t.resolved_at,
          conversation: t.conversation ?? null,
        })),
      );
      const nowIso = new Date(now).toISOString();

      const userName = new Map(
        users.map((u) => [
          u.id,
          [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '—',
        ]),
      );

      const ticketSla: TicketSla[] = tickets.map((t) => {
        /* Normalised (owner, 2026-10-07): two states only. ~7,900 imported rows
           store `closed`, and the status filter and pill read this field. */
        const status = normaliseTicketStatus(t.status);
        const solved = status === 'solved';
        const solveInput = {
          createdAt: t.date_created,
          resolvedAt: t.resolved_at,
          chatStartAt: solveCtx.session.get(t.id)?.customerAt ?? null,
          solvedServerAt: solveCtx.solvedServerAt.get(t.id) ?? null,
        };
        /* The ticket's actual solve time — the shared rule, so this row and
           the Agent summary's median agree (2026-10-15). */
        const span = solved ? ticketSolveSpan(solveInput) : null;
        const solveSec = solved ? ticketSolveSec(solveInput, slaHours.ticket) : null;

        /*
         * RESOLUTION. The stamped deadline when there is one. Without one, the
         * policy that governs the ticket, judged on the time it really took —
         * the sweep only stamps tickets it sees UNSOLVED, and most are closed
         * seconds after they are raised (12 of 16 on 14-15 Oct 2026).
         */
        let resolution: SlaCell;
        if (t.resolution_due_at) {
          resolution = { ...classify(t.resolution_due_at, t.resolved_at, now), source: 'deadline' };
        } else {
          const policy = governingPolicy(policies, {
            priority: t.priority,
            complaintType: t.complaint_type ?? null,
            complaintSource: t.complaint_source ?? null,
            brandName: t.store_snapshot?.brandName ?? null,
            vendor: t.vendor,
            createdAt: t.date_created,
          });
          const targetSec = policy?.resolution_minutes ? policy.resolution_minutes * 60 : null;
          if (solved && solveSec == null) {
            resolution = { state: 'na', dueAt: null, doneAt: null, naReason: 'noSolveTime' };
          } else if (!policy || targetSec == null) {
            resolution = { state: 'na', dueAt: null, doneAt: t.resolved_at, naReason: 'noPolicy' };
          } else {
            // Judged in the policy's own hours, as the sweep would have.
            const hours = parseBusinessHours(policy.business_hours);
            /* The engine's interval (raised -> solved), with the shared rule's
               correction for a solve stamp that runs behind the server. */
            const taken = solved
              ? ticketSolveSec({ ...solveInput, chatStartAt: null }, hours)
              : businessSecondsBetween(t.date_created, nowIso, hours);
            let state: SlaState = 'pending';
            if (taken != null && taken > targetSec) state = 'breached';
            else if (solved) state = 'met';
            resolution = {
              state,
              dueAt: null,
              doneAt: t.resolved_at,
              source: 'policy',
              policyName: policy.name ?? null,
            };
          }
        }

        /*
         * 1st REPLY. From the chat session the ticket was raised from when it
         * has one — the ticket's own `first_responded_at` is only the moment
         * an agent first ACTED on it (usually the solve), stamped by the
         * agent's PC clock, which runs behind the server's and made the
         * interval negative, i.e. blank, on 14 of 16 tickets.
         */
        let responseSec: number | null = null;
        let replySource: TicketSla['replySource'] = null;
        const session = solveCtx.session.get(t.id);
        if (session?.agentAt) {
          responseSec = businessSecondsBetween(session.customerAt, session.agentAt, slaHours.chat);
          if (responseSec != null) replySource = 'chat';
        }
        if (responseSec == null && t.first_responded_at) {
          responseSec =
            businessSecondsBetween(t.date_created, t.first_responded_at, slaHours.ticket) ??
            // Same clock as the stamp: the complaint time the same browser wrote.
            businessSecondsBetween(t.complaint_date, t.first_responded_at, slaHours.ticket) ??
            // Still backwards: acted on the moment it was raised.
            0;
          replySource = 'ticket';
        }

        return {
          id: t.id,
          subject: t.subject || '(no subject)',
          priority: t.priority,
          status,
          agentId: t.assigned_agent,
          agentName: t.assigned_agent ? (userName.get(t.assigned_agent) ?? '—') : 'Unassigned',
          created: t.date_created,
          // Always `na` now — the columns behind it are never written. Kept on
          // the row so the per-agent aggregate below still compiles and reports
          // zero rather than silently dropping a field other code may read.
          firstResponse: classify(t.first_response_due_at, t.first_responded_at, now),
          resolution,
          responseMinutes: responseSec == null ? null : responseSec / 60,
          replySource,
          solveMinutes: solveSec == null ? null : solveSec / 60,
          solveBasis:
            solveSec == null || !span
              ? null
              : span.endBasis === 'instant'
                ? 'instant'
                : span.endBasis === 'server'
                  ? 'server'
                  : span.startBasis,
        };
      });

      // Group per agent (unassigned tickets bucket under a single "Unassigned" row).
      const map = new Map<string, AgentSla>();
      const resp = new Map<string, { sum: number; count: number }>();
      for (const t of ticketSla) {
        const key = t.agentId ?? '__unassigned__';
        let a = map.get(key);
        if (!a) {
          a = {
            agentId: t.agentId,
            agentName: t.agentName,
            tickets: 0,
            frMet: 0,
            frBreached: 0,
            frPending: 0,
            frPct: null,
            resMet: 0,
            resBreached: 0,
            resPending: 0,
            resPct: null,
            avgResponseMin: null,
            breaches: 0,
          };
          map.set(key, a);
        }
        a.tickets += 1;
        if (t.firstResponse.state === 'met') a.frMet += 1;
        else if (t.firstResponse.state === 'breached') a.frBreached += 1;
        else if (t.firstResponse.state === 'pending') a.frPending += 1;
        if (t.resolution.state === 'met') a.resMet += 1;
        else if (t.resolution.state === 'breached') a.resBreached += 1;
        else if (t.resolution.state === 'pending') a.resPending += 1;
        if (t.responseMinutes != null) {
          const r = resp.get(key) ?? { sum: 0, count: 0 };
          r.sum += t.responseMinutes;
          r.count += 1;
          resp.set(key, r);
        }
      }

      const agents = Array.from(map.entries())
        .map(([key, a]) => {
          const frDecided = a.frMet + a.frBreached;
          const resDecided = a.resMet + a.resBreached;
          const r = resp.get(key);
          return {
            ...a,
            frPct: frDecided ? (a.frMet / frDecided) * 100 : null,
            resPct: resDecided ? (a.resMet / resDecided) * 100 : null,
            avgResponseMin: r && r.count ? r.sum / r.count : null,
            breaches: a.frBreached + a.resBreached,
          };
        })
        .sort((a, b) => b.breaches - a.breaches || b.tickets - a.tickets);

      /*
       * Chat first response, judged the same way the sweep does: answered
       * inside the deadline is met, answered after it or still unanswered past
       * it is breached, still unanswered inside it is undecided and counts
       * towards neither.
       */
      let chatMet = 0;
      let chatBreached = 0;
      for (const c of chats) {
        if (!c.first_response_due_at) continue;
        const due = new Date(c.first_response_due_at).getTime();
        if (c.first_responded_at) {
          if (new Date(c.first_responded_at).getTime() <= due) chatMet += 1;
          else chatBreached += 1;
        } else if (due < now) {
          chatBreached += 1;
        }
      }
      const chatDecided = chatMet + chatBreached;

      let resMet = 0;
      let resBr = 0;
      let breaches = 0;
      for (const t of ticketSla) {
        if (t.resolution.state === 'met') resMet += 1;
        else if (t.resolution.state === 'breached') {
          resBr += 1;
          breaches += 1;
        }
      }

      return {
        tickets: ticketSla,
        agents,
        totals: {
          tickets: ticketSla.length,
          frPct: chatDecided ? (chatMet / chatDecided) * 100 : null,
          frChats: chatDecided,
          resPct: resMet + resBr ? (resMet / (resMet + resBr)) * 100 : null,
          breaches,
        },
      };
    },
  });
}
