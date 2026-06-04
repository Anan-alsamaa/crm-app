import type { Job } from 'bullmq';
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
 * Seven report types are defined in the schema; this implementation
 * computes the four that ship with US7's MVP (conversation_volume,
 * response_time, sla_compliance, ticket_resolution). The remaining three
 * fall back to an empty-but-valid CSV so the schedule still fires and the
 * admin sees "no data" rather than an error.
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
}

function applyRange(filter: Record<string, unknown>, range: RangeFilter, field: string): void {
  if (range.from || range.to) {
    const r: Record<string, unknown> = {};
    if (range.from) r._gte = range.from;
    if (range.to) r._lte = range.to;
    filter[field] = r;
  }
  if (range.vendor) filter.vendor = { _eq: range.vendor };
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

const AGGREGATORS: Record<
  string,
  (deps: ReportsDeps, range: RangeFilter) => Promise<{ rows: string[][]; rowCount: number }>
> = {
  conversation_volume: reportConversationVolume,
  response_time: reportResponseTime,
  sla_compliance: reportSlaCompliance,
  ticket_resolution: reportTicketResolution,
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
