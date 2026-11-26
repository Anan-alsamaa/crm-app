import { BRANCH_MESSAGE_KIND } from '@yiji/shared-types';

/**
 * AGENT KPI -> BRANCH NOTIFICATIONS (owner, 26 Nov 2026): everything sent to
 * a branch's SaraPOS printer in a window - the automatic notification a ticket
 * raises, and the custom messages agents write with no ticket. Pure functions
 * over the outbox rows, so the numbers are tested without a browser.
 */

export type NotifyStatus = 'queued' | 'sent' | 'failed';
export type NotifyKind = 'ticket' | 'custom';

export interface NotifyRow {
  id: string;
  kind?: string | null;
  status: NotifyStatus;
  complaint_type?: string | null;
  order_id?: string | null;
  description?: string | null;
  error?: string | null;
  attempts?: number | null;
  date_created: string | null;
  sent_at?: string | null;
  sender_name?: string | null;
  sender_login?: string | null;
  user_created?: string | null;
  store?: { id?: string | null; code?: string | null; name?: string | null } | null;
}

export const kindOf = (r: NotifyRow): NotifyKind =>
  r.kind === BRANCH_MESSAGE_KIND ? 'custom' : 'ticket';

/** "LCP-095 One Square RYD", or a dash. */
export const branchLabel = (r: NotifyRow): string =>
  [r.store?.code, r.store?.name].filter(Boolean).join(' ') || '—';

/** Seconds from queued to accepted by SaraPOS, or null when it was not sent. */
export function sendSeconds(r: NotifyRow): number | null {
  if (r.status !== 'sent' || !r.sent_at || !r.date_created) return null;
  const s = (Date.parse(r.sent_at) - Date.parse(r.date_created)) / 1000;
  return Number.isFinite(s) && s >= 0 ? s : null;
}

export interface Totals {
  total: number;
  ticket: number;
  custom: number;
  sent: number;
  failed: number;
  queued: number;
  /** Average queued -> sent, in seconds, over the rows that were sent. */
  avgSendSec: number | null;
}

export function totals(rows: NotifyRow[]): Totals {
  const secs = rows.map(sendSeconds).filter((s): s is number => s !== null);
  return {
    total: rows.length,
    ticket: rows.filter((r) => kindOf(r) === 'ticket').length,
    custom: rows.filter((r) => kindOf(r) === 'custom').length,
    sent: rows.filter((r) => r.status === 'sent').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    queued: rows.filter((r) => r.status === 'queued').length,
    avgSendSec: secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : null,
  };
}

export interface BranchLine {
  key: string;
  branch: string;
  ticket: number;
  custom: number;
  failed: number;
  total: number;
  last: string | null;
}

/** One line per branch, busiest first. */
export function byBranch(rows: NotifyRow[]): BranchLine[] {
  const m = new Map<string, BranchLine>();
  for (const r of rows) {
    const key = r.store?.id ?? branchLabel(r);
    const line = m.get(key) ?? {
      key,
      branch: branchLabel(r),
      ticket: 0,
      custom: 0,
      failed: 0,
      total: 0,
      last: null,
    };
    line.total += 1;
    if (kindOf(r) === 'custom') line.custom += 1;
    else line.ticket += 1;
    if (r.status === 'failed') line.failed += 1;
    if (r.date_created && (!line.last || r.date_created > line.last)) line.last = r.date_created;
    m.set(key, line);
  }
  return [...m.values()].sort((a, b) => b.total - a.total || a.branch.localeCompare(b.branch));
}

export interface SenderLine {
  key: string;
  name: string;
  login: string | null;
  messages: number;
  branches: number;
  failed: number;
  last: string | null;
}

/**
 * Who wrote custom messages. The name kept ON the message wins; older ones
 * fall back to `nameOf(user_created)` - the account, while it exists.
 */
export function bySender(
  rows: NotifyRow[],
  nameOf: (userId: string | null | undefined) => string | null,
): SenderLine[] {
  const m = new Map<string, SenderLine & { stores: Set<string> }>();
  for (const r of rows) {
    if (kindOf(r) !== 'custom') continue;
    const key = r.user_created ?? r.sender_login ?? r.sender_name ?? 'unknown';
    const line = m.get(key) ?? {
      key,
      name: r.sender_name || nameOf(r.user_created) || '—',
      login: r.sender_login ?? null,
      messages: 0,
      branches: 0,
      failed: 0,
      last: null,
      stores: new Set<string>(),
    };
    line.messages += 1;
    if (r.status === 'failed') line.failed += 1;
    line.stores.add(r.store?.id ?? branchLabel(r));
    line.branches = line.stores.size;
    if (!line.login && r.sender_login) line.login = r.sender_login;
    if (r.date_created && (!line.last || r.date_created > line.last)) line.last = r.date_created;
    m.set(key, line);
  }
  return [...m.values()]
    .map(({ stores: _stores, ...l }) => l)
    .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
}

export interface TypeLine {
  type: string;
  count: number;
  branches: number;
}

/** Ticket notifications by ticket type, most frequent first. */
export function byTicketType(rows: NotifyRow[]): TypeLine[] {
  const m = new Map<string, { count: number; stores: Set<string> }>();
  for (const r of rows) {
    if (kindOf(r) !== 'ticket') continue;
    const type = r.complaint_type?.trim() || '—';
    const e = m.get(type) ?? { count: 0, stores: new Set<string>() };
    e.count += 1;
    e.stores.add(r.store?.id ?? branchLabel(r));
    m.set(type, e);
  }
  return [...m.entries()]
    .map(([type, e]) => ({ type, count: e.count, branches: e.stores.size }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** Search across branch, sender, order, ticket type and the text itself. */
export function matches(
  r: NotifyRow,
  needle: string,
  nameOf: (userId: string | null | undefined) => string | null,
): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return [
    branchLabel(r),
    r.sender_name,
    r.sender_login,
    nameOf(r.user_created),
    r.order_id,
    r.complaint_type,
    r.description,
  ].some((f) => (f ?? '').toLowerCase().includes(q));
}

/** A timestamp as Riyadh wall-clock, "26/11/2026 13:29" - the zone every report speaks. */
export function riyadhTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d
    .toLocaleString('en-GB', {
      timeZone: 'Asia/Riyadh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(',', '');
}
