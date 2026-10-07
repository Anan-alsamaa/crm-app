import { useQuery } from '@tanstack/react-query';
import { readItems, readUsers } from '@directus/sdk';
import {
  normaliseTicketStatus,
  UNSOLVED_TICKET_STATUSES_STORED,
  type StoreSnapshot,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * THE OPEN-TICKET BACKLOG, as it stands NOW (owner, 2026-10-07: "for tickets
 * there should be some data/table which shows the open tickets ... in the
 * Ticket deadlines page").
 *
 * Deliberately NOT bound to the page's date range. Everything else on the
 * deadlines page asks "of the tickets raised in this window, which kept their
 * promise?" — a historical question. The backlog is a present-tense one: a
 * ticket raised two months ago and still unsolved is open work TODAY, and a
 * window that hid it would report a smaller backlog than the one agents have.
 *
 * "Open" here means the ticket status `pending` — the one unfinished state of
 * the two (see TicketStatus). Stored rows are not migrated, so the server-side
 * filter still names the retired `open`/`new` spellings, and a row with no
 * status at all is included because the normaliser reads it as pending.
 *
 * No id lists are sent, so the CloudFront 414 on large `_in` filters does not
 * apply: the only `_in` is three status words.
 */

export const DUE_SOON_HOURS = 24;

const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'] as const;

export interface OpenTicketRaw {
  id: string;
  status: string | null;
  priority: string | null;
  assigned_agent: string | null;
  resolution_due_at: string | null;
  store_snapshot?: StoreSnapshot | null;
  store?: { brand?: { name?: string | null } | null } | null;
}

export interface OpenTicketUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export interface OpenBacklogRow {
  /** Null for the "Unassigned" / "No brand" bucket. */
  key: string | null;
  name: string;
  pending: number;
  overdue: number;
}

export interface OpenTicketStats {
  /** Every ticket still pending. */
  total: number;
  /** Resolution deadline already passed. */
  overdue: number;
  /** Deadline inside the next DUE_SOON_HOURS, not yet passed. */
  dueSoon: number;
  /** No resolution deadline at all — never promised anything. */
  noDeadline: number;
  byPriority: Array<{ key: string; count: number }>;
  byAgent: OpenBacklogRow[];
  byBrand: OpenBacklogRow[];
}

/** Worst first: the overdue pile is what someone opens this table to find. */
const byWorst = (a: OpenBacklogRow, b: OpenBacklogRow) =>
  b.overdue - a.overdue || b.pending - a.pending || a.name.localeCompare(b.name);

/**
 * Pure, so the arithmetic is tested without a Directus. Rows that are not
 * pending are ignored even if a caller passes them — the query filters already,
 * but a count that trusts its input to be pre-filtered is how a solved ticket
 * ends up in a backlog.
 */
export function summariseOpenTickets(
  rows: OpenTicketRaw[],
  users: OpenTicketUser[],
  now: number,
  labels: { unassigned: string; noBrand: string } = {
    unassigned: 'Unassigned',
    noBrand: 'No brand',
  },
): OpenTicketStats {
  const userName = new Map(
    users.map((u) => [
      u.id,
      [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '—',
    ]),
  );
  const soon = now + DUE_SOON_HOURS * 3_600_000;
  let total = 0;
  let overdue = 0;
  let dueSoon = 0;
  let noDeadline = 0;
  const prio = new Map<string, number>();
  const agents = new Map<string, OpenBacklogRow>();
  const brands = new Map<string, OpenBacklogRow>();

  const bump = (
    m: Map<string, OpenBacklogRow>,
    key: string | null,
    name: string,
    late: boolean,
  ) => {
    const k = key ?? '__none__';
    const row = m.get(k) ?? { key, name, pending: 0, overdue: 0 };
    row.pending += 1;
    if (late) row.overdue += 1;
    m.set(k, row);
  };

  for (const r of rows) {
    if (normaliseTicketStatus(r.status) !== 'pending') continue;
    total += 1;
    const due = r.resolution_due_at ? new Date(r.resolution_due_at).getTime() : NaN;
    const late = Number.isFinite(due) && due < now;
    if (!Number.isFinite(due)) noDeadline += 1;
    else if (late) overdue += 1;
    else if (due <= soon) dueSoon += 1;

    const p = r.priority || 'medium';
    prio.set(p, (prio.get(p) ?? 0) + 1);

    bump(
      agents,
      r.assigned_agent,
      r.assigned_agent ? (userName.get(r.assigned_agent) ?? '—') : labels.unassigned,
      late,
    );
    /* The brand FROZEN on the ticket first, like every other report, so editing
       a store today cannot move an old ticket; the live relation only for rows
       raised before snapshots existed. */
    const brand = r.store_snapshot?.brandName?.trim() || r.store?.brand?.name?.trim() || '';
    bump(brands, brand || null, brand || labels.noBrand, late);
  }

  const rank = (k: string) => {
    const i = (PRIORITY_ORDER as readonly string[]).indexOf(k);
    return i === -1 ? 99 : i;
  };
  return {
    total,
    overdue,
    dueSoon,
    noDeadline,
    byPriority: [...prio.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key)),
    byAgent: [...agents.values()].sort(byWorst),
    byBrand: [...brands.values()].sort(byWorst),
  };
}

const FIELDS_WITH_BRAND = [
  'id',
  'status',
  'priority',
  'assigned_agent',
  'resolution_due_at',
  'store_snapshot',
  { store: [{ brand: ['name'] }] },
];
const FIELDS_PLAIN = ['id', 'status', 'priority', 'assigned_agent', 'resolution_due_at'];

/** The page names the null buckets itself (translated), keyed on `key === null`. */
export function useOpenTicketStats() {
  return useQuery({
    queryKey: ['sla-open-tickets'],
    staleTime: 60_000,
    queryFn: async (): Promise<OpenTicketStats> => {
      const filter = {
        _or: [
          { status: { _in: [...UNSOLVED_TICKET_STATUSES_STORED] } },
          { status: { _null: true } },
        ],
      };
      const read = (fields: unknown[]) =>
        directus.request(
          readItems('tickets', { filter: filter as never, fields: fields as never, limit: -1 }),
        ) as Promise<OpenTicketRaw[]>;
      const [rows, users] = await Promise.all([
        /* A Directus without the store snapshot / relation rejects the WHOLE
           query for one unknown field (403), so fall back to the plain columns
           rather than take the backlog down — brand then reads "No brand",
           which is visibly a gap rather than a plausible zero. */
        read(FIELDS_WITH_BRAND).catch(() => read(FIELDS_PLAIN)),
        directus.request(
          readUsers({ fields: ['id', 'first_name', 'last_name', 'email'], limit: -1 }),
        ) as Promise<OpenTicketUser[]>,
      ]);
      return summariseOpenTickets(rows, users, Date.now());
    },
  });
}
