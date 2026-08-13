import type { CellValue, Sheet, Translate } from '@yiji/reports';
import type { AgentKpiRow, ConversationStatusReport, TicketReportRow } from './api.js';

/**
 * The complaints report is shared with the agent portal, so its row shape,
 * columns and sheet builder live in `@yiji/reports`. Re-exported here so this
 * module stays the one import site for "report builders" within this app.
 */
export {
  buildComplaintsSheets,
  COMPLAINT_COLUMN_KEYS,
  COMPLAINT_COLUMN_LABELS,
  reportFilename,
  type ComplaintColumnKey,
  type Translate,
} from '@yiji/reports';

/**
 * Pure builders that turn the aggregated report data into `.xlsx` sheet
 * definitions. Kept free of React/i18n: the page passes already-translated
 * header strings via `t`, so the same builders serve EN and AR (and the values
 * themselves are locale-neutral — ISO-ish dates + raw numbers Excel can sum).
 */

/** status.* / priority.* live in the shared `common` namespace, not `agent`. */
function common(key: string, fallback: string, t: Translate): string {
  return t(key, { ns: 'common', defaultValue: fallback });
}

/** Stable, locale-independent `YYYY-MM-DD HH:mm` (blank for null/invalid). */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/** Round minutes to a whole number for the export (null → blank cell). */
function roundMin(n: number | null): CellValue {
  return n == null ? '' : Math.round(n);
}

/**
 * A store-derived cell (brand / city / manager).
 *
 * Three states, and they must stay distinguishable:
 *   no order at all      → blank
 *   order, no store row  → "Not mapped"  (someone must add the store)
 *   order + store row    → the value, or blank if that field is simply empty
 *
 * Collapsing the middle case to a blank cell is the failure mode to avoid: it
 * reads as "this ticket had no order" and hides a mapping gap that silently
 * skews every by-store and by-brand total.
 */
function storeCell(
  r: TicketReportRow,
  pick: (o: NonNullable<TicketReportRow['order']>) => string | undefined,
  t: Translate,
): string {
  const o = r.order;
  if (!o) return '';
  if (o.storeMapped === false) return t('agentReports.notMapped', { defaultValue: 'Not mapped' });
  return pick(o) ?? '';
}

function round1(n: number | null): CellValue {
  return n == null ? '' : Math.round(n * 10) / 10;
}

function slaLabel(state: string, t: Translate): string {
  return t(`agentReports.sla.${state}`, {
    defaultValue: state === 'na' ? '—' : state,
  });
}

/* ── Report 1: Tickets + order data ───────────────────────────────────── */

/**
 * The selectable columns for the Tickets export, in order. `labelKey`/`def` feed
 * the on-screen column picker; the builder below maps each key to its header +
 * per-row value, so the picker and the sheet never drift apart.
 */
export const TICKET_COLUMN_KEYS = [
  'id',
  'subject',
  'status',
  'priority',
  'contact',
  'email',
  'phone',
  'agent',
  'created',
  'firstResponseMin',
  'firstResponseSla',
  'resolutionMin',
  'resolutionSla',
  'orderId',
  'restaurant',
  'brand',
  'city',
  'areaManager',
  'chainManager',
  'orderStatus',
  'delivery',
  'items',
  'orderTotal',
] as const;
export type TicketColumnKey = (typeof TICKET_COLUMN_KEYS)[number];

export const TICKET_COLUMN_LABELS: Record<TicketColumnKey, { key: string; def: string }> = {
  id: { key: 'agentReports.col.ticketId', def: 'Ticket ID' },
  subject: { key: 'agentReports.col.subject', def: 'Subject' },
  status: { key: 'agentReports.col.status', def: 'Status' },
  priority: { key: 'agentReports.col.priority', def: 'Priority' },
  contact: { key: 'agentReports.col.contact', def: 'Contact' },
  email: { key: 'agentReports.col.email', def: 'Email' },
  phone: { key: 'agentReports.col.phone', def: 'Phone' },
  agent: { key: 'agentReports.col.agent', def: 'Agent' },
  created: { key: 'agentReports.col.created', def: 'Created' },
  firstResponseMin: { key: 'agentReports.col.firstResponseMin', def: 'First response (min)' },
  firstResponseSla: { key: 'agentReports.col.firstResponseSla', def: 'First response SLA' },
  resolutionMin: { key: 'agentReports.col.resolutionMin', def: 'Resolution (min)' },
  resolutionSla: { key: 'agentReports.col.resolutionSla', def: 'Resolution SLA' },
  orderId: { key: 'agentReports.col.orderId', def: 'Order ID' },
  restaurant: { key: 'agentReports.col.restaurant', def: 'Restaurant' },
  brand: { key: 'agentReports.col.brand', def: 'Brand' },
  city: { key: 'agentReports.col.city', def: 'City' },
  areaManager: { key: 'agentReports.col.areaManager', def: 'Area manager' },
  chainManager: { key: 'agentReports.col.chainManager', def: 'Chain manager' },
  orderStatus: { key: 'agentReports.col.orderStatus', def: 'Order status' },
  delivery: { key: 'agentReports.col.delivery', def: 'Delivery' },
  items: { key: 'agentReports.col.items', def: 'Items' },
  orderTotal: { key: 'agentReports.col.orderTotal', def: 'Order total' },
};

/**
 * Build the Tickets sheet. `enabled` selects which columns to include (order
 * preserved); omitted/empty → all columns. The rows are ALWAYS the full dataset
 * the caller passes — pagination only limits the on-screen preview, never the
 * export.
 */
export function buildTicketsSheets(
  rows: TicketReportRow[],
  t: Translate,
  enabled?: readonly TicketColumnKey[],
): Sheet[] {
  const width: Record<TicketColumnKey, number> = {
    id: 26,
    subject: 34,
    status: 12,
    priority: 12,
    contact: 22,
    email: 24,
    phone: 16,
    agent: 20,
    created: 18,
    firstResponseMin: 18,
    firstResponseSla: 16,
    resolutionMin: 16,
    resolutionSla: 14,
    orderId: 16,
    restaurant: 26,
    brand: 20,
    city: 16,
    areaManager: 22,
    chainManager: 22,
    orderStatus: 16,
    delivery: 26,
    items: 40,
    orderTotal: 14,
  };
  const value: Record<TicketColumnKey, (r: TicketReportRow) => CellValue> = {
    id: (r) => r.id,
    subject: (r) => r.subject,
    status: (r) => common(`status.${r.status}`, r.status, t),
    priority: (r) => common(`priority.${r.priority}`, r.priority, t),
    contact: (r) => r.contactName,
    email: (r) => r.contactEmail,
    phone: (r) => r.contactPhone,
    agent: (r) => r.agentName,
    created: (r) => fmtDateTime(r.createdAt),
    firstResponseMin: (r) => roundMin(r.firstResponseMinutes),
    firstResponseSla: (r) => slaLabel(r.firstResponseState, t),
    resolutionMin: (r) => roundMin(r.resolutionMinutes),
    resolutionSla: (r) => slaLabel(r.resolutionState, t),
    orderId: (r) => r.order?.orderId ?? '',
    restaurant: (r) => r.order?.restaurant ?? '',
    // A ticket with an order but no matching store row says so explicitly. A
    // blank cell reads as "no order", which would hide the mapping gap that
    // someone needs to fix in Restaurants → Stores.
    brand: (r) => storeCell(r, (o) => o.brand, t),
    city: (r) => storeCell(r, (o) => o.city, t),
    areaManager: (r) => storeCell(r, (o) => o.areaManager, t),
    chainManager: (r) => storeCell(r, (o) => o.chainManager, t),
    orderStatus: (r) => r.order?.status ?? '',
    delivery: (r) => r.order?.delivery ?? '',
    items: (r) => r.order?.items ?? '',
    orderTotal: (r) => r.order?.total ?? '',
  };

  const keys = (enabled && enabled.length ? enabled : TICKET_COLUMN_KEYS).filter(
    (k): k is TicketColumnKey => (TICKET_COLUMN_KEYS as readonly string[]).includes(k),
  );

  return [
    {
      name: t('agentReports.tab.tickets', { defaultValue: 'Tickets' }),
      columns: keys.map((k) => ({
        header: t(TICKET_COLUMN_LABELS[k].key, { defaultValue: TICKET_COLUMN_LABELS[k].def }),
        width: width[k],
      })),
      rows: rows.map((r) => keys.map((k) => value[k](r))),
    },
  ];
}

/* ── Report 2: Agent KPI ──────────────────────────────────────────────── */

export function buildAgentKpiSheets(agents: AgentKpiRow[], t: Translate): Sheet[] {
  const columns = [
    { header: t('agentReports.col.agent', { defaultValue: 'Agent' }), width: 24 },
    { header: t('agentReports.col.tickets', { defaultValue: 'Tickets' }), width: 12 },
    { header: t('agentReports.col.responded', { defaultValue: 'Responded' }), width: 12 },
    {
      header: t('agentReports.col.avgFirstResponseMin', {
        defaultValue: 'Avg first response (min)',
      }),
      width: 22,
    },
    {
      header: t('agentReports.col.firstResponsePct', { defaultValue: 'First response SLA %' }),
      width: 18,
    },
    { header: t('agentReports.col.csatCount', { defaultValue: 'CSAT responses' }), width: 16 },
    { header: t('agentReports.col.csatAvg', { defaultValue: 'CSAT avg (1–5)' }), width: 16 },
  ];

  const data: CellValue[][] = agents.map((a) => [
    a.agentName,
    a.tickets,
    a.responded,
    roundMin(a.avgFirstResponseMin),
    a.firstResponsePct == null ? '' : Math.round(a.firstResponsePct),
    a.csatCount,
    round1(a.csatAvg),
  ]);

  return [
    {
      name: t('agentReports.tab.agentKpi', { defaultValue: 'Agent KPI' }),
      columns,
      rows: data,
    },
  ];
}

/* ── Report 3: Conversation status ────────────────────────────────────── */

export function buildConversationSheets(report: ConversationStatusReport, t: Translate): Sheet[] {
  // Sheet A — status / priority summary (counts).
  const summaryRows: CellValue[][] = [];
  summaryRows.push([t('agentReports.byStatus', { defaultValue: 'By status' }), '']);
  for (const s of report.byStatus) {
    summaryRows.push([common(`status.${s.key}`, s.key, t), s.count]);
  }
  summaryRows.push(['', '']);
  summaryRows.push([t('agentReports.byPriority', { defaultValue: 'By priority' }), '']);
  for (const p of report.byPriority) {
    summaryRows.push([common(`priority.${p.key}`, p.key, t), p.count]);
  }
  summaryRows.push(['', '']);
  summaryRows.push([t('agentReports.total', { defaultValue: 'Total' }), report.total]);

  const summarySheet: Sheet = {
    name: t('agentReports.tab.summary', { defaultValue: 'Summary' }),
    columns: [
      { header: t('agentReports.col.metric', { defaultValue: 'Metric' }), width: 24 },
      { header: t('agentReports.col.count', { defaultValue: 'Count' }), width: 12 },
    ],
    rows: summaryRows,
  };

  // Sheet B — per-day counts, one column per status.
  const dayColumns = [
    { header: t('agentReports.col.date', { defaultValue: 'Date' }), width: 14 },
    { header: t('agentReports.col.total', { defaultValue: 'Total' }), width: 10 },
    ...report.statuses.map((s) => ({
      header: common(`status.${s}`, s, t),
      width: 12,
    })),
  ];
  const dayRows: CellValue[][] = report.byDay.map((d) => [
    d.day,
    d.total,
    ...report.statuses.map((s) => d.byStatus[s] ?? 0),
  ]);
  const daySheet: Sheet = {
    name: t('agentReports.tab.byDay', { defaultValue: 'By day' }),
    columns: dayColumns,
    rows: dayRows,
  };

  // Sheet C — conversation detail (row per conversation).
  //
  // Customer, phone and order lead: a sheet of conversation UUIDs is something
  // nobody can act on, and the point of exporting a status report is to have a
  // list to work through. The id stays, at the end, for anyone matching rows
  // back against the system.
  const detailColumns = [
    { header: t('agentReports.col.customer', { defaultValue: 'Customer' }), width: 22 },
    { header: t('agentReports.col.phone', { defaultValue: 'Phone' }), width: 18 },
    { header: t('agentReports.col.email', { defaultValue: 'Email' }), width: 24 },
    { header: t('agentReports.col.orderNumber', { defaultValue: 'Order' }), width: 14 },
    { header: t('agentReports.col.status', { defaultValue: 'Status' }), width: 12 },
    { header: t('agentReports.col.priority', { defaultValue: 'Priority' }), width: 12 },
    { header: t('agentReports.col.agent', { defaultValue: 'Agent' }), width: 20 },
    { header: t('agentReports.col.created', { defaultValue: 'Created' }), width: 18 },
    { header: t('agentReports.col.lastMessage', { defaultValue: 'Last message' }), width: 18 },
    {
      header: t('agentReports.col.conversationId', { defaultValue: 'Conversation ID' }),
      width: 26,
    },
  ];
  const detailRows: CellValue[][] = report.rows.map((c) => [
    c.customerName,
    c.customerPhone,
    c.customerEmail,
    c.orderId,
    common(`status.${c.status}`, c.status, t),
    common(`priority.${c.priority}`, c.priority, t),
    c.agentName,
    fmtDateTime(c.createdAt),
    fmtDateTime(c.lastMessageAt),
    c.id,
  ]);
  const detailSheet: Sheet = {
    name: t('agentReports.tab.conversations', { defaultValue: 'Conversations' }),
    columns: detailColumns,
    rows: detailRows,
  };

  return [summarySheet, daySheet, detailSheet];
}

/** `reports-tickets-30d-2026-07-22.xlsx` style filename. */
