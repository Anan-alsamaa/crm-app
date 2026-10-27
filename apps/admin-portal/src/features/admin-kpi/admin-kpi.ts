import { couponDecision } from '@yiji/shared-types';

/**
 * ADMIN KPI - the arithmetic (owner, 2026-10-21).
 *
 * Pure: every block on the page is a Directus `aggregate` (a grouped COUNT,
 * computed by the server) or a small column read, folded here into the
 * figures the page shows. Kept apart from the page so the folding is tested
 * without React or Directus, and so a figure means one thing everywhere.
 *
 * Grouped counts, not row downloads: a month of `yiji_api_usage` is tens of
 * thousands of rows, and a list of ids in a filter is the CloudFront 414 trap
 * (memory: cloudfront-414-large-in-filters). Nothing here builds an `_in`.
 */

/** One row of a Directus aggregate: the groupBy fields plus `count` (string or number). */
export type GroupRow = Record<string, unknown> & { count?: unknown };

/** Directus answers counts and sums as strings on Postgres; anything unreadable is 0. */
export function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** The `count` of an ungrouped aggregate (`[{ count: '12' }]`). */
export function totalOf(rows: readonly GroupRow[] | null | undefined): number {
  return (rows ?? []).reduce((s, r) => s + toNum(r.count), 0);
}

/** `{ value: count }` for one groupBy field. A null value is keyed `''`. */
export function countsBy(
  rows: readonly GroupRow[] | null | undefined,
  field: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) {
    const raw = r[field];
    const key = raw === null || raw === undefined ? '' : String(raw);
    out[key] = (out[key] ?? 0) + toNum(r.count);
  }
  return out;
}

/* ── Chats ─────────────────────────────────────────────────────────── */

export interface ChatSummary {
  total: number;
  open: number;
  closed: number;
  /** Chats with a first agent reply, and the mean wait for it (seconds). */
  responded: number;
  avgFirstResponseSec: number | null;
}

export function chatSummary(
  byStatus: readonly GroupRow[] | null | undefined,
  responded: ReadonlyArray<{ date_created?: string | null; first_responded_at?: string | null }>,
): ChatSummary {
  const s = countsBy(byStatus, 'status');
  const waits: number[] = [];
  for (const r of responded ?? []) {
    const a = Date.parse(r.date_created ?? '');
    const b = Date.parse(r.first_responded_at ?? '');
    /* A reply stamped BEFORE the chat opened is a clock or import artefact,
       not a negative wait; it is left out rather than dragging the mean down. */
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) waits.push((b - a) / 1000);
  }
  return {
    total: Object.values(s).reduce((x, y) => x + y, 0),
    open: s.open ?? 0,
    closed: s.solved ?? 0,
    responded: waits.length,
    avgFirstResponseSec: waits.length
      ? Math.round(waits.reduce((x, y) => x + y, 0) / waits.length)
      : null,
  };
}

/* ── Tickets ───────────────────────────────────────────────────────── */

export interface TicketSummary {
  created: number;
  byStatus: Record<string, number>;
  compensated: number;
  notCompensated: number;
  /** `Initial` or blank: no compensation decided yet. */
  undecided: number;
}

export function ticketSummary(
  byStatus: readonly GroupRow[] | null | undefined,
  byCompensation: readonly GroupRow[] | null | undefined,
): TicketSummary {
  const status = countsBy(byStatus, 'status');
  const comp = countsBy(byCompensation, 'compensation');
  const created = Object.values(status).reduce((x, y) => x + y, 0);
  const compensated = comp['Compensated'] ?? 0;
  const notCompensated = comp['Not Compensated'] ?? 0;
  return {
    created,
    byStatus: status,
    compensated,
    notCompensated,
    undecided: Math.max(
      0,
      Object.values(comp).reduce((x, y) => x + y, 0) - compensated - notCompensated,
    ),
  };
}

/* ── Coupons ───────────────────────────────────────────────────────── */

export interface CouponSummary {
  requested: number;
  approved: number;
  rejected: number;
  pending: number;
  pushed: number;
  pushFailures: number;
  withheld: number;
  /** `removal_status` -> count, only coupons that have one. */
  removal: Record<string, number>;
  /**
   * Approved coupons EDITED after approval (owner, 2026-10-27): each one was
   * replaced by a new coupon, which is the one counted above - the old row is
   * history and is NOT in requested/approved/rejected/pending.
   */
  replaced: number;
}

export function couponSummary(input: {
  byStatus: readonly GroupRow[] | null | undefined;
  pushed: readonly GroupRow[] | null | undefined;
  pushFailures: readonly GroupRow[] | null | undefined;
  withheld: readonly GroupRow[] | null | undefined;
  byRemoval: readonly GroupRow[] | null | undefined;
  /**
   * The rows to leave OUT, by status (`couponIsSuperseded`): old coupons an
   * edit replaced, and edits that were abandoned. Null when the fields are not
   * applied yet - then nothing can have been replaced.
   */
  superseded?: readonly GroupRow[] | null | undefined;
}): CouponSummary {
  const out = { requested: 0, approved: 0, rejected: 0, pending: 0 };
  const left = countsBy(input.superseded, 'status');
  let replaced = 0;
  for (const [status, all] of Object.entries(countsBy(input.byStatus, 'status'))) {
    /* Never below zero, whatever the two reads saw between them. */
    const gone = Math.min(all, left[status] ?? 0);
    const n = all - gone;
    out.requested += n;
    /* THROUGH couponDecision: 'approved', 'edited' and 'assigned' are all an
       approval - comparing to the literal 'approved' once halved a total. */
    out[couponDecision(status)] += n;
    if (couponDecision(status) === 'approved') replaced += gone;
  }
  const removal = countsBy(input.byRemoval, 'removal_status');
  delete removal[''];
  return {
    ...out,
    pushed: totalOf(input.pushed),
    pushFailures: totalOf(input.pushFailures),
    withheld: totalOf(input.withheld),
    removal,
    replaced,
  };
}

/* ── Late orders ───────────────────────────────────────────────────── */

export interface LateOrderSummary {
  /** Every decision row in the window (a comment edited later is still one). */
  decisions: number;
  /** Distinct orders, each counted by its NEWEST decision. */
  orders: number;
  commented: number;
  compensated: number;
}

/**
 * NEWEST DECISION PER ORDER WINS - the rule the Late orders report uses, so
 * an order commented on and then compensated counts once, as compensated.
 * `action: 'ignored'` is what the screens call "Commented".
 */
export function lateOrderSummary(
  rows: ReadonlyArray<{
    order_id?: string | null;
    action?: string | null;
    date_created?: string | null;
  }>,
): LateOrderSummary {
  const newest = new Map<string, { action: string; at: number }>();
  for (const r of rows ?? []) {
    const id = String(r.order_id ?? '').trim();
    if (!id) continue;
    const at = Date.parse(r.date_created ?? '') || 0;
    const prev = newest.get(id);
    if (!prev || at > prev.at) newest.set(id, { action: String(r.action ?? ''), at });
  }
  let commented = 0;
  let compensated = 0;
  for (const { action } of newest.values()) {
    if (action === 'compensated') compensated += 1;
    else commented += 1;
  }
  return { decisions: (rows ?? []).length, orders: newest.size, commented, compensated };
}

/* ── AI calls ──────────────────────────────────────────────────────── */

export interface AiSummary {
  calls: number;
  errors: number;
  costUsd: number;
  tokens: number;
  avgLatencyMs: number | null;
}

/** From `aggregate({ count, sum: [...], avg: ['latency_ms'] }, groupBy: ['status'])`. */
export function aiSummary(rows: readonly GroupRow[] | null | undefined): AiSummary {
  let calls = 0;
  let errors = 0;
  let costUsd = 0;
  let tokens = 0;
  let latencyWeighted = 0;
  for (const r of rows ?? []) {
    const n = toNum(r.count);
    calls += n;
    if (r.status === 'error') errors += n;
    const sum = (r.sum ?? {}) as Record<string, unknown>;
    costUsd += toNum(sum.est_cost_usd);
    tokens += toNum(sum.input_tokens) + toNum(sum.output_tokens) + toNum(sum.thinking_tokens);
    latencyWeighted += toNum((r.avg as Record<string, unknown> | undefined)?.latency_ms) * n;
  }
  return {
    calls,
    errors,
    costUsd,
    tokens,
    avgLatencyMs: calls ? Math.round(latencyWeighted / calls) : null,
  };
}

/* ── Yiji API usage ────────────────────────────────────────────────── */

export interface YijiUsageTotals {
  total: number;
  crm: number;
  backup: number;
  ok: number;
  refused: number;
  error: number;
  /** Share of calls the BACKUP made, 0..100; null with no calls. */
  backupPct: number | null;
}

/** From a count grouped by `account, outcome`. */
export function yijiUsageTotals(rows: readonly GroupRow[] | null | undefined): YijiUsageTotals {
  const t = { total: 0, crm: 0, backup: 0, ok: 0, refused: 0, error: 0 };
  for (const r of rows ?? []) {
    const n = toNum(r.count);
    t.total += n;
    if (r.account === 'backup') t.backup += n;
    else t.crm += n;
    if (r.outcome === 'ok') t.ok += n;
    else if (r.outcome === 'refused') t.refused += n;
    else t.error += n;
  }
  return { ...t, backupPct: t.total ? Math.round((t.backup / t.total) * 1000) / 10 : null };
}

export interface YijiOperationRow {
  operation: string;
  total: number;
  crm: number;
  backup: number;
  refused: number;
  error: number;
}

/** From a count grouped by `operation, account, outcome`; busiest first. */
export function yijiOperations(rows: readonly GroupRow[] | null | undefined): YijiOperationRow[] {
  const by = new Map<string, YijiOperationRow>();
  for (const r of rows ?? []) {
    const op = String(r.operation ?? 'other') || 'other';
    const row = by.get(op) ?? { operation: op, total: 0, crm: 0, backup: 0, refused: 0, error: 0 };
    const n = toNum(r.count);
    row.total += n;
    if (r.account === 'backup') row.backup += n;
    else row.crm += n;
    if (r.outcome === 'refused') row.refused += n;
    else if (r.outcome === 'error') row.error += n;
    by.set(op, row);
  }
  return [...by.values()].sort(
    (a, b) => b.total - a.total || a.operation.localeCompare(b.operation),
  );
}

/**
 * The calendar day of a row grouped by `year(date_created)`, `month(...)`,
 * `day(...)`. Directus names a function column `date_created_year`; the
 * literal `year(date_created)` is accepted too so a version difference cannot
 * silently empty the chart.
 */
export function dayKeyOf(row: GroupRow): string | null {
  const part = (fn: string) => toNum(row[`date_created_${fn}`] ?? row[`${fn}(date_created)`]);
  const y = part('year');
  const m = part('month');
  const d = part('day');
  if (!y || !m || !d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface YijiTrendDay {
  day: string;
  crm: number;
  backup: number;
  /** Refused or errored, either account. */
  failed: number;
}

/**
 * One point per calendar day from `from` to `to` (inclusive), zero-filled - a
 * day with no calls is a real zero here, not a gap - capped at `maxDays` so an
 * absurd range cannot draw a thousand points.
 */
export function yijiDailyTrend(
  rows: readonly GroupRow[] | null | undefined,
  from: string,
  to: string,
  maxDays = 120,
): YijiTrendDay[] {
  const by = new Map<string, YijiTrendDay>();
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    for (let t = start, i = 0; t <= end && i < maxDays; t += 86_400_000, i++) {
      const day = new Date(t).toISOString().slice(0, 10);
      by.set(day, { day, crm: 0, backup: 0, failed: 0 });
    }
  }
  for (const r of rows ?? []) {
    const day = dayKeyOf(r);
    if (!day) continue;
    const point = by.get(day);
    /* Outside the zero-filled window (UTC edges, or the cap): left out. */
    if (!point) continue;
    const n = toNum(r.count);
    if (r.account === 'backup') point.backup += n;
    else point.crm += n;
    if (r.outcome === 'refused' || r.outcome === 'error') point.failed += n;
  }
  return [...by.values()];
}

/** The calendar days a business-day window touches (its UTC dates). */
export function windowDays(fromIso: string, toIso: string): { from: string; to: string } {
  return { from: fromIso.slice(0, 10), to: toIso.slice(0, 10) };
}
