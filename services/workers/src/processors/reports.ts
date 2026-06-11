import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItems, readItem, updateItem } from '@directus/sdk';
import type { ReportJob } from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';
import type { MailTransport } from '../mail/index.js';

/**
 * Reports processor.
 *
 * Runs the aggregation for a single saved report, renders a CSV, and (if
 * the report has `schedule.email` recipients) emails it. Bumps last_run_at
 * on the report row.
 *
 * All seven report types are implemented: conversation_volume, response_time,
 * sla_compliance, ticket_resolution, agent_productivity, csat, vendor_activity.
 * An unknown type still falls back to an empty-but-valid CSV so a misconfigured
 * schedule fires "no data" rather than erroring.
 */

export interface ReportsDeps {
  directus: YijiDirectusClient;
  mail: MailTransport;
  logger: Logger;
}

export interface ReportRow {
  id: string;
  name: string;
  type: string;
  filters: Record<string, unknown> | null;
  schedule: Record<string, unknown> | null;
}

export interface ReportResult {
  reportId: string;
  type: string;
  generatedAt: string;
  csv: string;
  rowCount: number;
}

/* ── Aggregations ─────────────────────────────────────────────────── */

interface RangeFilter {
  from?: string;
  to?: string;
  vendor?: string;
  agent?: string;
  team?: string;
}

/** Apply only the date range to `field` (for collections without a vendor column). */
function applyDateRange(filter: Record<string, unknown>, range: RangeFilter, field: string): void {
  if (range.from || range.to) {
    const r: Record<string, unknown> = {};
    if (range.from) r._gte = range.from;
    if (range.to) r._lte = range.to;
    filter[field] = r;
  }
}

/** Assignment scoping for collections that carry assigned_agent/assigned_team. */
function applyAssignment(filter: Record<string, unknown>, range: RangeFilter): void {
  if (range.agent) filter.assigned_agent = { _eq: range.agent };
  if (range.team) filter.assigned_team = { _eq: range.team };
}

function applyRange(filter: Record<string, unknown>, range: RangeFilter, field: string): void {
  applyDateRange(filter, range, field);
  if (range.vendor) filter.vendor = { _eq: range.vendor };
  applyAssignment(filter, range);
}

async function reportConversationVolume(
  deps: ReportsDeps,
  range: RangeFilter,
): Promise<{ rows: string[][]; rowCount: number }> {
  const filter: Record<string, unknown> = {};
  applyRange(filter, range, 'date_created');
  const conversations = (await deps.directus.request(
    readItems('conversations', {
      filter,
      fields: ['id', 'status', 'date_created', 'vendor'],
      limit: -1,
    }),
  )) as Array<{ id: string; status: string; date_created: string | null; vendor: string }>;

  // Bucket by day.
  const byDay = new Map<string, { open: number; total: number }>();
  for (const c of conversations) {
    const day = (c.date_created ?? '').slice(0, 10);
    const bucket = byDay.get(day) ?? { open: 0, total: 0 };
    bucket.total += 1;
    if (c.status === 'open') bucket.open += 1;
    byDay.set(day, bucket);
  }
  const rows: string[][] = [['day', 'total', 'open']];
  for (const day of Array.from(byDay.keys()).sort()) {
    const b = byDay.get(day)!;
    rows.push([day, String(b.total), String(b.open)]);
  }
  return { rows, rowCount: rows.length - 1 };
}

async function reportResponseTime(
  deps: ReportsDeps,
  range: RangeFilter,
): Promise<{ rows: string[][]; rowCount: number }> {
  const filter: Record<string, unknown> = { first_responded_at: { _nnull: true } };
  applyRange(filter, range, 'date_created');
  const tickets = (await deps.directus.request(
    readItems('tickets', {
      filter,
      fields: ['id', 'subject', 'date_created', 'first_responded_at', 'priority'],
      limit: -1,
    }),
  )) as Array<{
    id: string;
    subject: string;
    date_created: string | null;
    first_responded_at: string | null;
    priority: string;
  }>;
  const rows: string[][] = [['ticket_id', 'subject', 'priority', 'response_minutes']];
  for (const t of tickets) {
    if (!t.date_created || !t.first_responded_at) continue;
    const dt = new Date(t.first_responded_at).getTime() - new Date(t.date_created).getTime();
    const minutes = Math.round(dt / 60_000);
    rows.push([t.id, t.subject, t.priority, String(minutes)]);
  }
  return { rows, rowCount: rows.length - 1 };
}

async function reportSlaCompliance(
  deps: ReportsDeps,
  range: RangeFilter,
): Promise<{ rows: string[][]; rowCount: number }> {
  const filter: Record<string, unknown> = {};
  applyRange(filter, range, 'date_created');
  const tickets = (await deps.directus.request(
    readItems('tickets', {
      filter,
      fields: [
        'id',
        'subject',
        'priority',
        'first_response_due_at',
        'first_responded_at',
        'resolution_due_at',
        'resolved_at',
      ],
      limit: -1,
    }),
  )) as Array<{
    id: string;
    subject: string;
    priority: string;
    first_response_due_at: string | null;
    first_responded_at: string | null;
    resolution_due_at: string | null;
    resolved_at: string | null;
  }>;
  const rows: string[][] = [
    ['ticket_id', 'subject', 'priority', 'first_response_met', 'resolution_met'],
  ];
  for (const t of tickets) {
    const firstMet =
      t.first_responded_at && t.first_response_due_at
        ? new Date(t.first_responded_at).getTime() <= new Date(t.first_response_due_at).getTime()
          ? 'yes'
          : 'no'
        : 'pending';
    const resMet =
      t.resolved_at && t.resolution_due_at
        ? new Date(t.resolved_at).getTime() <= new Date(t.resolution_due_at).getTime()
          ? 'yes'
          : 'no'
        : 'pending';
    rows.push([t.id, t.subject, t.priority, firstMet, resMet]);
  }
  return { rows, rowCount: rows.length - 1 };
}

async function reportTicketResolution(
  deps: ReportsDeps,
  range: RangeFilter,
): Promise<{ rows: string[][]; rowCount: number }> {
  const filter: Record<string, unknown> = {};
  applyRange(filter, range, 'date_created');
  const tickets = (await deps.directus.request(
    readItems('tickets', {
      filter,
      fields: ['id', 'subject', 'status', 'priority', 'date_created', 'resolved_at'],
      limit: -1,
    }),
  )) as Array<{
    id: string;
    subject: string;
    status: string;
    priority: string;
    date_created: string | null;
    resolved_at: string | null;
  }>;
  const rows: string[][] = [['ticket_id', 'subject', 'status', 'priority', 'resolution_minutes']];
  for (const t of tickets) {
    let minutes = '';
    if (t.date_created && t.resolved_at) {
      const dt = new Date(t.resolved_at).getTime() - new Date(t.date_created).getTime();
      minutes = String(Math.round(dt / 60_000));
    }
    rows.push([t.id, t.subject, t.status, t.priority, minutes]);
  }
  return { rows, rowCount: rows.length - 1 };
}

export async function reportAgentProductivity(
  deps: ReportsDeps,
  range: RangeFilter,
): Promise<{ rows: string[][]; rowCount: number }> {
  const filter: Record<string, unknown> = { assigned_agent: { _nnull: true } };
  applyDateRange(filter, range, 'date_created');
  applyAssignment(filter, range);
  const tickets = (await deps.directus.request(
    readItems('tickets', {
      filter,
      fields: ['id', 'assigned_agent', 'status', 'date_created', 'resolved_at'],
      limit: -1,
    }),
  )) as Array<{
    id: string;
    assigned_agent: string | null;
    status: string;
    date_created: string | null;
    resolved_at: string | null;
  }>;

  const byAgent = new Map<
    string,
    { assigned: number; resolved: number; totalMin: number; resCount: number }
  >();
  for (const t of tickets) {
    if (!t.assigned_agent) continue;
    const b = byAgent.get(t.assigned_agent) ?? {
      assigned: 0,
      resolved: 0,
      totalMin: 0,
      resCount: 0,
    };
    b.assigned += 1;
    if (t.status === 'resolved' || t.status === 'closed') {
      b.resolved += 1;
      if (t.date_created && t.resolved_at) {
        b.totalMin +=
          (new Date(t.resolved_at).getTime() - new Date(t.date_created).getTime()) / 60_000;
        b.resCount += 1;
      }
    }
    byAgent.set(t.assigned_agent, b);
  }
  const rows: string[][] = [
    ['agent_id', 'assigned', 'resolved', 'resolution_rate_pct', 'avg_resolution_minutes'],
  ];
  for (const agent of Array.from(byAgent.keys()).sort()) {
    const b = byAgent.get(agent)!;
    const rate = b.assigned ? Math.round((100 * b.resolved) / b.assigned) : 0;
    const avg = b.resCount ? String(Math.round(b.totalMin / b.resCount)) : '';
    rows.push([agent, String(b.assigned), String(b.resolved), String(rate), avg]);
  }
  return { rows, rowCount: rows.length - 1 };
}

export async function reportCsat(
  deps: ReportsDeps,
  range: RangeFilter,
): Promise<{ rows: string[][]; rowCount: number }> {
  const filter: Record<string, unknown> = {};
  applyDateRange(filter, range, 'submitted_at');
  const responses = (await deps.directus.request(
    readItems('csat_responses', { filter, fields: ['id', 'score', 'submitted_at'], limit: -1 }),
  )) as Array<{ id: string; score: number | null }>;

  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  let n = 0;
  for (const r of responses) {
    if (typeof r.score === 'number' && r.score >= 1 && r.score <= 5) {
      dist[r.score] = (dist[r.score] ?? 0) + 1;
      sum += r.score;
      n += 1;
    }
  }
  const rows: string[][] = [
    ['metric', 'value'],
    ['responses', String(n)],
    ['average_score', n ? (sum / n).toFixed(2) : '0'],
  ];
  for (let s = 1; s <= 5; s += 1) rows.push([`score_${s}`, String(dist[s] ?? 0)]);
  return { rows, rowCount: n };
}

export async function reportVendorActivity(
  deps: ReportsDeps,
  range: RangeFilter,
): Promise<{ rows: string[][]; rowCount: number }> {
  const filter: Record<string, unknown> = {};
  applyRange(filter, range, 'date_created');
  const conversations = (await deps.directus.request(
    readItems('conversations', { filter, fields: ['id', 'vendor', 'status'], limit: -1 }),
  )) as Array<{ id: string; vendor: string | null; status: string }>;

  const byVendor = new Map<string, { total: number; open: number; resolved: number }>();
  for (const c of conversations) {
    const v = c.vendor ?? 'unknown';
    const b = byVendor.get(v) ?? { total: 0, open: 0, resolved: 0 };
    b.total += 1;
    if (c.status === 'open') b.open += 1;
    if (c.status === 'resolved' || c.status === 'closed') b.resolved += 1;
    byVendor.set(v, b);
  }
  const rows: string[][] = [['vendor_id', 'conversations', 'open', 'resolved']];
  for (const v of Array.from(byVendor.keys()).sort()) {
    const b = byVendor.get(v)!;
    rows.push([v, String(b.total), String(b.open), String(b.resolved)]);
  }
  return { rows, rowCount: rows.length - 1 };
}

const AGGREGATORS: Record<
  string,
  (deps: ReportsDeps, range: RangeFilter) => Promise<{ rows: string[][]; rowCount: number }>
> = {
  conversation_volume: reportConversationVolume,
  response_time: reportResponseTime,
  sla_compliance: reportSlaCompliance,
  ticket_resolution: reportTicketResolution,
  agent_productivity: reportAgentProductivity,
  csat: reportCsat,
  vendor_activity: reportVendorActivity,
};

/* ── CSV rendering ────────────────────────────────────────────────── */

export function rowsToCsv(rows: string[][]): string {
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

/* ── Processor ───────────────────────────────────────────────────── */

export async function processReportJob(
  job: Job<ReportJob>,
  deps: ReportsDeps,
): Promise<ReportResult> {
  const { reportId } = job.data;
  const report = (await deps.directus.request(
    readItem('reports', reportId, {
      fields: ['id', 'name', 'type', 'filters', 'schedule'],
    }),
  )) as ReportRow | null;
  if (!report) throw new Error(`report ${reportId} not found`);

  const range: RangeFilter = (report.filters ?? {}) as RangeFilter;
  const aggregator = AGGREGATORS[report.type];
  let rows: string[][];
  let rowCount = 0;
  if (aggregator) {
    const agg = await aggregator(deps, range);
    rows = agg.rows;
    rowCount = agg.rowCount;
  } else {
    rows = [['note'], [`Aggregation for "${report.type}" is not yet implemented.`]];
  }

  const csv = rowsToCsv(rows);
  const generatedAt = new Date().toISOString();

  // Email if schedule has recipients.
  const recipients = (report.schedule?.email as string[] | undefined) ?? [];
  if (recipients.length > 0) {
    try {
      await deps.mail.send({
        to: recipients.join(', '),
        subject: `[YIJI] Report: ${report.name}`,
        text: `Report "${report.name}" (${report.type}) generated at ${generatedAt}.\nRows: ${rowCount}.\n\nCSV attached below:\n\n${csv}`,
      });
    } catch (err) {
      deps.logger.warn({ reportId, err: (err as Error).message }, 'report email failed');
    }
  }

  // Mark last_run_at.
  try {
    await deps.directus.request(
      updateItem('reports', reportId, { last_run_at: generatedAt } as never),
    );
  } catch {
    /* ignore */
  }

  return { reportId, type: report.type, generatedAt, csv, rowCount };
}

/**
 * Reconcile BullMQ Job Schedulers against the saved reports that carry a
 * `schedule.cron`. Each such report gets one scheduler (`report:<id>`) that
 * BullMQ fires on its cron pattern, enqueueing a normal report job (handled by
 * processReportJob → generate CSV + email recipients + bump last_run_at).
 * Schedulers for reports whose cron was removed/changed or that were deleted
 * are pruned. Idempotent — safe to call at startup and on a periodic re-sync.
 *
 * This is what makes "scheduled reports" actually fire (spec §16 / §18). Without
 * it, a report's cron is stored but nothing ever triggers it.
 */
export async function syncScheduledReports(
  reportsQueue: Queue,
  deps: { directus: ReportsDeps['directus']; logger: Logger },
): Promise<{ active: number; removed: number }> {
  const PREFIX = 'report:';
  const rows = (await deps.directus.request(
    readItems('reports', { fields: ['id', 'schedule'], limit: -1 }),
  )) as Array<{ id: string; schedule: { cron?: string } | null }>;

  // Desired scheduler id -> cron pattern, for every report with a non-empty cron.
  const desired = new Map<string, string>();
  for (const r of rows) {
    const cron = r.schedule?.cron?.trim();
    if (cron) desired.set(`${PREFIX}${r.id}`, cron);
  }

  // Upsert one scheduler per scheduled report (idempotent by scheduler id). A
  // bad cron is logged and skipped so one misconfigured report can't break the
  // whole sweep.
  for (const [id, cron] of [...desired]) {
    const reportId = id.slice(PREFIX.length);
    try {
      await reportsQueue.upsertJobScheduler(
        id,
        { pattern: cron },
        { name: 'scheduled-report', data: { reportId } },
      );
    } catch (err) {
      deps.logger.warn(
        { reportId, cron, err: (err as Error).message },
        'invalid report cron — scheduler not set',
      );
      desired.delete(id);
    }
  }

  // Prune schedulers whose report no longer wants one.
  let removed = 0;
  const existing = await reportsQueue.getJobSchedulers();
  for (const s of existing) {
    const key = (s as { key?: string }).key;
    if (key && key.startsWith(PREFIX) && !desired.has(key)) {
      await reportsQueue.removeJobScheduler(key);
      removed += 1;
    }
  }

  deps.logger.info({ active: desired.size, removed }, 'scheduled reports synced');
  return { active: desired.size, removed };
}
