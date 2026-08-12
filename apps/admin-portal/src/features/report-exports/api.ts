import { useQuery } from '@tanstack/react-query';
import { readItems, readUsers } from '@directus/sdk';
import { directus } from '../../lib/directus.js';
import { commerce } from '../../lib/commerce-client.js';
import type { StoreSnapshot } from '@yiji/shared-types';
// The complaints row shape is shared with the agent portal — see @yiji/reports.
import { splitLocalDateTime, type ComplaintReportRow } from '@yiji/reports';

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
  last_message_at: string | null;
  contact: string | null;
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
  tickets: number;
  /** Tickets that have a first response recorded. */
  responded: number;
  avgFirstResponseMin: number | null;
  /** First-response SLA compliance % over decided (met+breached) tickets. */
  firstResponsePct: number | null;
  csatCount: number;
  /** Mean CSAT score 1–5 over the agent's rated conversations. */
  csatAvg: number | null;
  /** Conversations auto-assigned to this agent that they did not answer in time. */
  missed: number;
  /** Auto-assignment offers made to them — the denominator for `missed`. */
  offered: number;
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
  'store_snapshot',
] as const;

/** Numeric cell that tolerates the sheet's `-`, `""` and `"102.85 SR"`. */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /-?\d+(\.\d+)?/.exec(v.replace(/,/g, ''));
  return m ? Number(m[0]) : null;
}

/* ── Base report data (Directus only — no commerce) ───────────────────── */

export function useAgentReportData(
  days: number,
  labels: { unassigned: string; noSubject: string },
) {
  return useQuery({
    queryKey: ['agent-reports', days, labels.unassigned, labels.noSubject],
    staleTime: 60_000,
    queryFn: async (): Promise<AgentReportData> => {
      const since = new Date(Date.now() - days * DAY_MS).toISOString();
      const now = Date.now();

      // Attempt the richer field list first; fall back to the base one if this
      // Directus has no complaint schema (see COMPLAINT_FIELDS).
      let complaintFieldsAvailable = true;
      const readTickets = async (): Promise<RawTicket[]> => {
        const query = (fields: readonly unknown[]) =>
          directus.request(
            readItems('tickets', {
              filter: { date_created: { _gte: since } },
              fields: fields as never,
              limit: -1,
              sort: ['-date_created'],
            }),
          ) as Promise<RawTicket[]>;
        try {
          return await query([...BASE_TICKET_FIELDS, ...COMPLAINT_FIELDS]);
        } catch {
          complaintFieldsAvailable = false;
          return await query(BASE_TICKET_FIELDS);
        }
      };

      const [tickets, conversations, csat, users] = await Promise.all([
        readTickets(),
        directus.request(
          readItems('conversations', {
            filter: { date_created: { _gte: since } },
            fields: [
              'id',
              'status',
              'priority',
              'assigned_agent',
              'date_created',
              'last_message_at',
              'contact',
            ],
            limit: -1,
            sort: ['-date_created'],
          }),
        ) as Promise<RawConversation[]>,
        directus.request(
          readItems('csat_responses', {
            filter: { submitted_at: { _gte: since } },
            fields: ['id', 'score', 'comment', 'submitted_at', 'conversation'],
            limit: -1,
          }),
        ) as Promise<RawCsat[]>,
        directus.request(
          readUsers({ fields: ['id', 'first_name', 'last_name', 'email'], limit: -1 }),
        ) as Promise<RawUser[]>,
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
      if (missingConvIds.length > 0) {
        const extraConvs = (await directus.request(
          readItems('conversations', {
            filter: { id: { _in: missingConvIds } },
            fields: ['id', 'assigned_agent'],
            limit: -1,
          }),
        )) as { id: string; assigned_agent: string | null }[];
        for (const c of extraConvs) convAgent.set(c.id, c.assigned_agent);
      }

      /* Report 1: tickets + SLA timings (order enrichment added later). */
      const ticketRows: TicketReportRow[] = tickets.map((t) => ({
        id: t.id,
        subject: t.subject || labels.noSubject,
        status: t.status,
        priority: t.priority,
        contactId: t.contact?.id ?? null,
        contactName: t.contact?.name ?? '',
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
      const complaintRows: ComplaintReportRow[] = tickets.map((t) => {
        const when = splitLocalDateTime(t.date_created);
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
          customerName: t.contact?.name ?? '',
          customerMobile: t.contact?.phone ?? '',
          complaintDescription: t.description ?? '',
          responseDesc: t.response_desc ?? '',
          complaintSource: t.complaint_source ?? '',
          orderAmount: toNumber(snap?.total),
          orderNumber: snap?.orderId ? String(snap.orderId) : '',
          communicationMethod: t.communication_method ?? '',
          couponCode: t.coupon_code ?? '',
          couponValue: toNumber(t.coupon_value),
          couponPercent: toNumber(t.coupon_percent),
          complaintStatus: t.status,
          agent: agentOf(t.assigned_agent),
          compensation: t.compensation ?? '',
          storeSnapshot: t.store_snapshot ?? null,
        };
      });

      /* Report 2: agent KPI — first response + CSAT. */
      interface Acc {
        agentId: string | null;
        agentName: string;
        tickets: number;
        responded: number;
        respSum: number;
        frMet: number;
        frBreached: number;
        csatSum: number;
        csatCount: number;
      }
      const accs = new Map<string, Acc>();
      const ensure = (id: string | null, name: string): Acc => {
        const key = id ?? '__unassigned__';
        let a = accs.get(key);
        if (!a) {
          a = {
            agentId: id,
            agentName: name,
            tickets: 0,
            responded: 0,
            respSum: 0,
            frMet: 0,
            frBreached: 0,
            csatSum: 0,
            csatCount: 0,
          };
          accs.set(key, a);
        }
        return a;
      };

      for (const t of tickets) {
        const agentId = realAgentId(t.assigned_agent);
        const a = ensure(agentId, agentOf(agentId));
        a.tickets += 1;
        const rm = minutesBetween(t.date_created, t.first_responded_at);
        if (rm != null) {
          a.responded += 1;
          a.respSum += rm;
        }
        const fr = slaOutcome(t.first_response_due_at, t.first_responded_at, now);
        if (fr === 'met') a.frMet += 1;
        else if (fr === 'breached') a.frBreached += 1;
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

      // Auto-assignment outcomes. Read separately because they live on their own
      // append-only table: a "miss" is not visible anywhere in tickets or
      // messages — the ladder just moves on — so it has to be counted here.
      const missedBy = new Map<string, number>();
      const offeredBy = new Map<string, number>();
      try {
        const events = (await directus.request(
          readItems('routing_events' as never, {
            filter: { date_created: { _gte: since } },
            fields: ['agent', 'outcome'],
            limit: -1,
          }) as never,
        )) as Array<{ agent: string | null; outcome: string }>;
        for (const e of events) {
          if (!e.agent) continue;
          offeredBy.set(e.agent, (offeredBy.get(e.agent) ?? 0) + 1);
          if (e.outcome === 'missed') missedBy.set(e.agent, (missedBy.get(e.agent) ?? 0) + 1);
        }
      } catch {
        // Collection not provisioned yet (bootstrap not re-run) — report zeroes
        // rather than failing the whole KPI query over one optional metric.
      }

      const agents: AgentKpiRow[] = Array.from(accs.values())
        .map((a) => {
          const decided = a.frMet + a.frBreached;
          return {
            agentId: a.agentId,
            agentName: a.agentName,
            tickets: a.tickets,
            responded: a.responded,
            avgFirstResponseMin: a.responded ? a.respSum / a.responded : null,
            firstResponsePct: decided ? (a.frMet / decided) * 100 : null,
            csatCount: a.csatCount,
            csatAvg: a.csatCount ? a.csatSum / a.csatCount : null,
            missed: missedBy.get(a.agentId ?? '') ?? 0,
            offered: offeredBy.get(a.agentId ?? '') ?? 0,
          };
        })
        .sort((x, y) => y.tickets - x.tickets || x.agentName.localeCompare(y.agentName));

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
        return {
          id: c.id,
          status: c.status,
          priority: c.priority,
          agentName: agentOf(c.assigned_agent),
          createdAt: c.date_created,
          lastMessageAt: c.last_message_at,
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

      return {
        tickets: ticketRows,
        complaints: complaintRows,
        complaintFieldsAvailable,
        agents,
        conversations: conversationsReport,
        csatOverall: {
          avg: csatOverallCount ? csatOverallSum / csatOverallCount : null,
          count: csatOverallCount,
        },
        generatedAt: new Date().toISOString(),
      };
    },
  });
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
        contacts = (await directus.request(
          readItems('contacts', {
            filter: { id: { _in: capped } },
            fields: ['id', 'external_customer_id', 'vendor.yiji_vendor_id'],
            limit: -1,
          }),
        )) as ContactCommerce[];
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
