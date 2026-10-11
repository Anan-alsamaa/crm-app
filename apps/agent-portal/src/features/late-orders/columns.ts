import { loadColumnOrder, reconcileColumnOrder, saveColumnOrder } from '@yiji/reports';

/**
 * THE LATE-ORDERS TABLE'S COLUMNS, as data (owner, 2026-10-11: "choose which
 * columns are shown and rearrange them, like the tickets breakdown").
 *
 * The array order IS the default order — the order the table had before the
 * picker existed — so a browser with nothing saved sees exactly what it saw.
 */
export const LATE_ORDER_COLUMN_KEYS = [
  'created',
  'businessDay',
  'order',
  'elapsed',
  'service',
  'driverArrival',
  'delivery',
  'preparation',
  'brand',
  'restaurant',
  'customer',
  'status',
  'kind',
  'agent',
  'reason',
  'actionTaken',
  'detail',
  'actions',
  'comments',
] as const;

export type LateOrderColumnKey = (typeof LATE_ORDER_COLUMN_KEYS)[number];

/** This browser's arrangement. A preference, never data. */
export const LATE_ORDER_COLUMNS_ORDER_KEY = 'late-orders-columns-order';
/** The columns switched OFF. Stored as the hidden set, not the shown one, so a
    column added later arrives SHOWN instead of silently missing. */
export const LATE_ORDER_COLUMNS_HIDDEN_KEY = 'late-orders-columns-hidden';

/** The saved order, reconciled: unknown keys dropped, new columns appended. */
export function loadLateOrderColumnOrder(): LateOrderColumnKey[] {
  return reconcileColumnOrder(
    loadColumnOrder<LateOrderColumnKey>(LATE_ORDER_COLUMNS_ORDER_KEY),
    LATE_ORDER_COLUMN_KEYS,
  );
}

export function saveLateOrderColumnOrder(order: readonly LateOrderColumnKey[]): void {
  saveColumnOrder(LATE_ORDER_COLUMNS_ORDER_KEY, order);
}

/**
 * The saved hidden set, restricted to columns that exist today. If it would
 * hide EVERYTHING (a hand-edited or stale value) it is ignored: an empty table
 * with no header to explain it reads as "no late orders".
 */
export function loadLateOrderHiddenColumns(): Set<LateOrderColumnKey> {
  const known = new Set<string>(LATE_ORDER_COLUMN_KEYS);
  const saved = loadColumnOrder<LateOrderColumnKey>(LATE_ORDER_COLUMNS_HIDDEN_KEY).filter((k) =>
    known.has(k),
  );
  if (saved.length >= LATE_ORDER_COLUMN_KEYS.length) return new Set();
  return new Set(saved);
}

export function saveLateOrderHiddenColumns(hidden: ReadonlySet<LateOrderColumnKey>): void {
  saveColumnOrder(LATE_ORDER_COLUMNS_HIDDEN_KEY, [...hidden]);
}

/**
 * Toggle one column, never leaving NONE shown — hiding the last visible column
 * is refused (the set comes back unchanged).
 */
export function toggleHiddenColumn(
  hidden: ReadonlySet<LateOrderColumnKey>,
  key: LateOrderColumnKey,
): Set<LateOrderColumnKey> {
  const next = new Set(hidden);
  if (next.has(key)) {
    next.delete(key);
    return next;
  }
  next.add(key);
  if (next.size >= LATE_ORDER_COLUMN_KEYS.length) return new Set(hidden);
  return next;
}

/** The columns ON, in the arranged order. */
export function visibleLateOrderColumns(
  order: readonly LateOrderColumnKey[],
  hidden: ReadonlySet<LateOrderColumnKey>,
): LateOrderColumnKey[] {
  return order.filter((k) => !hidden.has(k));
}

/**
 * The picker's name for each column — the header's own words, except the
 * cart-and-tracking column, whose header ("Order") would read as a second
 * "Order" in the list beside the order number.
 */
export const LATE_ORDER_COLUMN_LABELS: Record<LateOrderColumnKey, { key: string; def: string }> = {
  created: { key: 'lateOrders.col.created', def: 'Creation time' },
  businessDay: { key: 'lateOrders.col.businessDay', def: 'Business day' },
  order: { key: 'lateOrders.col.order', def: 'Order' },
  elapsed: { key: 'lateOrders.col.elapsed', def: 'Total time' },
  service: { key: 'lateOrders.col.service', def: 'Service time' },
  driverArrival: { key: 'lateOrders.col.driverArrival', def: 'Driver arrival' },
  delivery: { key: 'lateOrders.col.delivery', def: 'Delivery time' },
  preparation: { key: 'lateOrders.col.preparation', def: 'Preparation time' },
  brand: { key: 'lateOrders.col.brandOnly', def: 'Brand' },
  restaurant: { key: 'lateOrders.col.restaurant', def: 'Restaurant' },
  customer: { key: 'lateOrders.col.customer', def: 'Customer mobile' },
  status: { key: 'lateOrders.col.status', def: 'Order status' },
  kind: { key: 'lateOrders.col.kind', def: 'Source of delay' },
  agent: { key: 'lateOrders.col.agent', def: 'Agent' },
  reason: { key: 'lateOrders.col.reason', def: 'Reason' },
  actionTaken: { key: 'lateOrders.col.actionTaken', def: 'Action taken' },
  detail: { key: 'lateOrders.showDetail', def: 'Cart & tracking' },
  actions: { key: 'lateOrders.col.actions', def: 'Decision' },
  comments: { key: 'lateOrders.col.comments', def: 'Comments' },
};

/* ── column widths (owner, 2026-10-11: "drag the column border") ─────────── */

/** This browser's column widths in px; absent = the table's natural widths. */
export const LATE_ORDER_COLUMN_WIDTHS_KEY = 'late-orders-columns-widths';
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 800;

export type LateOrderColumnWidths = Partial<Record<LateOrderColumnKey, number>>;

export const clampColumnWidth = (w: number): number =>
  Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w)));

/** The saved widths, keeping only known columns and sane numbers. */
export function loadLateOrderColumnWidths(): LateOrderColumnWidths | null {
  try {
    const raw = window.localStorage.getItem(LATE_ORDER_COLUMN_WIDTHS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: LateOrderColumnWidths = {};
    for (const k of LATE_ORDER_COLUMN_KEYS) {
      const v = parsed[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampColumnWidth(v);
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export function saveLateOrderColumnWidths(widths: LateOrderColumnWidths | null): void {
  try {
    if (widths) window.localStorage.setItem(LATE_ORDER_COLUMN_WIDTHS_KEY, JSON.stringify(widths));
    else window.localStorage.removeItem(LATE_ORDER_COLUMN_WIDTHS_KEY);
  } catch {
    /* storage unavailable: the widths last for this visit */
  }
}
