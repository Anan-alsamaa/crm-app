import type { CellValue, Sheet } from './xlsx.js';
import type {
  AgentKpiRow,
  ConversationStatusReport,
  TicketReportRow,
} from './api.js';

/**
 * Pure builders that turn the aggregated report data into `.xlsx` sheet
 * definitions. Kept free of React/i18n: the page passes already-translated
 * header strings via `t`, so the same builders serve EN and AR (and the values
 * themselves are locale-neutral — ISO-ish dates + raw numbers Excel can sum).
 */

export type Translate = (key: string, opts?: { defaultValue: string; ns?: string }) => string;

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

function round1(n: number | null): CellValue {
  return n == null ? '' : Math.round(n * 10) / 10;
}

function slaLabel(state: string, t: Translate): string {
  return t(`agentReports.sla.${state}`, {
    defaultValue: state === 'na' ? '—' : state,
  });
}

/* ── Report 1: Tickets + order data ───────────────────────────────────── */

export function buildTicketsSheets(rows: TicketReportRow[], t: Translate): Sheet[] {
  const columns = [
    { header: t('agentReports.col.ticketId', { defaultValue: 'Ticket ID' }), width: 26 },
    { header: t('agentReports.col.subject', { defaultValue: 'Subject' }), width: 34 },
    { header: t('agentReports.col.status', { defaultValue: 'Status' }), width: 12 },
    { header: t('agentReports.col.priority', { defaultValue: 'Priority' }), width: 12 },
    { header: t('agentReports.col.contact', { defaultValue: 'Contact' }), width: 22 },
    { header: t('agentReports.col.email', { defaultValue: 'Email' }), width: 24 },
    { header: t('agentReports.col.phone', { defaultValue: 'Phone' }), width: 16 },
    { header: t('agentReports.col.agent', { defaultValue: 'Agent' }), width: 20 },
    { header: t('agentReports.col.created', { defaultValue: 'Created' }), width: 18 },
    {
      header: t('agentReports.col.firstResponseMin', { defaultValue: 'First response (min)' }),
      width: 18,
    },
    { header: t('agentReports.col.firstResponseSla', { defaultValue: 'First response SLA' }), width: 16 },
    { header: t('agentReports.col.resolutionMin', { defaultValue: 'Resolution (min)' }), width: 16 },
    { header: t('agentReports.col.resolutionSla', { defaultValue: 'Resolution SLA' }), width: 14 },
    { header: t('agentReports.col.orderId', { defaultValue: 'Order ID' }), width: 16 },
    { header: t('agentReports.col.restaurant', { defaultValue: 'Restaurant' }), width: 22 },
    { header: t('agentReports.col.orderStatus', { defaultValue: 'Order status' }), width: 16 },
    { header: t('agentReports.col.delivery', { defaultValue: 'Delivery' }), width: 26 },
    { header: t('agentReports.col.items', { defaultValue: 'Items' }), width: 40 },
    { header: t('agentReports.col.orderTotal', { defaultValue: 'Order total' }), width: 14 },
  ];

  const data: CellValue[][] = rows.map((r) => [
    r.id,
    r.subject,
    common(`status.${r.status}`, r.status, t),
    common(`priority.${r.priority}`, r.priority, t),
    r.contactName,
    r.contactEmail,
    r.contactPhone,
    r.agentName,
    fmtDateTime(r.createdAt),
    roundMin(r.firstResponseMinutes),
    slaLabel(r.firstResponseState, t),
    roundMin(r.resolutionMinutes),
    slaLabel(r.resolutionState, t),
    r.order?.orderId ?? '',
    r.order?.restaurant ?? '',
    r.order?.status ?? '',
    r.order?.delivery ?? '',
    r.order?.items ?? '',
    r.order?.total ?? '',
  ]);

  return [
    {
      name: t('agentReports.tab.tickets', { defaultValue: 'Tickets' }),
      columns,
      rows: data,
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

export function buildConversationSheets(
  report: ConversationStatusReport,
  t: Translate,
): Sheet[] {
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
  const detailColumns = [
    { header: t('agentReports.col.conversationId', { defaultValue: 'Conversation ID' }), width: 26 },
    { header: t('agentReports.col.status', { defaultValue: 'Status' }), width: 12 },
    { header: t('agentReports.col.priority', { defaultValue: 'Priority' }), width: 12 },
    { header: t('agentReports.col.agent', { defaultValue: 'Agent' }), width: 20 },
    { header: t('agentReports.col.created', { defaultValue: 'Created' }), width: 18 },
    { header: t('agentReports.col.lastMessage', { defaultValue: 'Last message' }), width: 18 },
  ];
  const detailRows: CellValue[][] = report.rows.map((c) => [
    c.id,
    common(`status.${c.status}`, c.status, t),
    common(`priority.${c.priority}`, c.priority, t),
    c.agentName,
    fmtDateTime(c.createdAt),
    fmtDateTime(c.lastMessageAt),
  ]);
  const detailSheet: Sheet = {
    name: t('agentReports.tab.conversations', { defaultValue: 'Conversations' }),
    columns: detailColumns,
    rows: detailRows,
  };

  return [summarySheet, daySheet, detailSheet];
}

/** `reports-tickets-30d-2026-07-22.xlsx` style filename. */
export function reportFilename(base: string, days: number): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${base}-${days}d-${today}.xlsx`;
}
