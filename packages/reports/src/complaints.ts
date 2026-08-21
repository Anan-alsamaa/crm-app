/**
 * The operations team's complaints report: one row shape and one column set,
 * shared by every portal that shows it.
 *
 * This lives in a package rather than in either portal because two audiences
 * need the SAME report from different vantage points — the operations manager
 * sees every complaint, an agent sees their own — and the one thing that must
 * never differ between them is the format. The columns are the ops team's own
 * spreadsheet, kept in their order and their wording; the moment a 25th column
 * is asked for it has to appear in both places or the two exports stop
 * reconciling, which is exactly the bug a copied definition guarantees.
 *
 * Free of React, i18next and Directus: callers pass an already-translated `t`
 * and rows they fetched themselves, so the same builders serve both portals in
 * EN and AR.
 */
import {
  isUnmappedStore,
  matchStore,
  resolveStoreAttribution,
  type StoreIndex,
  type StoreSnapshot,
} from '@yiji/shared-types';
import type { CellValue, Sheet } from './xlsx.js';

export type Translate = (key: string, opts?: { defaultValue: string; ns?: string }) => string;

/** status.* / priority.* live in the shared `common` namespace. */
function common(key: string, fallback: string, t: Translate): string {
  return t(key, { ns: 'common', defaultValue: fallback });
}

/** One complaint, in the shape the ops team's sheet expects. */
export interface ComplaintReportRow {
  id: string;
  /** Local `YYYY-MM-DD` of ticket creation. */
  date: string;
  /** Calendar parts of `date`, for pivoting. Null when there is no date. */
  year: number | null;
  month: number | null;
  week: number | null;
  day: number | null;
  /** Local `HH:mm` of ticket creation. */
  time: string;
  /** Chain manager, from the matched store. */
  chain: string;
  /** Area manager, from the matched store. */
  area: string;
  brand: string;
  city: string;
  restaurantName: string;
  /** Ops store code ("LCP-041"), for searching. Filled by the store join. */
  storeCode: string;
  /** Yiji's restaurant id, for searching. Filled by the store join. */
  yijiRestaurantId: string;
  /** False when no store row matched — rendered as "Not mapped", never blank. */
  storeMapped: boolean;
  serviceType: string;
  complaintType: string;
  /**
   * Not a report column — the ops sheet has never carried one and their
   * required format omits it. Kept on the row because the agent portal's own
   * table shows it.
   */
  customerName: string;
  customerMobile: string;
  complaintDescription: string;
  responseDesc: string;
  complaintSource: string;
  orderAmount: number | null;
  orderNumber: string;
  communicationMethod: string;
  couponCode: string;
  couponValue: number | null;
  couponPercent: number | null;
  /** Ticket status — translated to the manager's wording at export time. */
  complaintStatus: string;
  agent: string;
  compensation: string;
  /**
   * Who touched the ticket last and when — blank until somebody edits it, the
   * way the ops team's own sheet behaved. Sourced from Directus's system
   * columns (user_updated / date_updated), so it covers portal edits, imports
   * and raw API writes alike.
   */
  lastModifiedBy: string;
  lastModifiedAt: string;
  /**
   * The branch attribution frozen onto the ticket when it was raised. Null
   * for tickets raised before snapshots existed, which fall back to a live
   * lookup and therefore DO move if a store is edited.
   */
  storeSnapshot: StoreSnapshot | null;
}

/**
 * The ops team's columns, in their order. `restaurantManagerId` has no source
 * field yet and is carried as a column, always blank, until one exists.
 */
/**
 * The report's columns, in the operations team's own order.
 *
 * Year / Month / Week / Day are derived from Date rather than stored: they
 * exist so the sheet can be pivoted by period without writing a formula, and
 * deriving them means they can never disagree with the date they came from.
 *
 * Customer name is deliberately absent — the ops sheet has never carried one
 * (it was empty on all 1,673 historical rows) and the mobile is the identifier
 * they actually use.
 */
export const COMPLAINT_COLUMN_KEYS = [
  'date',
  'year',
  'month',
  'week',
  'day',
  'chain',
  'area',
  'brand',
  'city',
  'restaurantName',
  'serviceType',
  'complaintType',
  'customerMobile',
  'complaintDescription',
  'responseDesc',
  'complaintSource',
  'time',
  'orderAmount',
  'orderNumber',
  'communicationMethod',
  'couponCode',
  'couponValue',
  'couponPercent',
  'complaintStatus',
  'restaurantManagerId',
  'agent',
  'compensation',
  'lastModifiedBy',
  'lastModifiedAt',
] as const;
export type ComplaintColumnKey = (typeof COMPLAINT_COLUMN_KEYS)[number];

export const COMPLAINT_COLUMN_LABELS: Record<ComplaintColumnKey, { key: string; def: string }> = {
  date: { key: 'complaintReport.col.date', def: 'Date' },
  year: { key: 'complaintReport.col.year', def: 'Year' },
  month: { key: 'complaintReport.col.month', def: 'Month' },
  week: { key: 'complaintReport.col.week', def: 'Week' },
  day: { key: 'complaintReport.col.day', def: 'Day' },
  time: { key: 'complaintReport.col.time', def: 'Time' },
  chain: { key: 'complaintReport.col.chain', def: 'Chain' },
  area: { key: 'complaintReport.col.area', def: 'Area' },
  brand: { key: 'complaintReport.col.brand', def: 'Brand' },
  city: { key: 'complaintReport.col.city', def: 'City' },
  restaurantName: { key: 'complaintReport.col.restaurantName', def: 'Restaurant name' },
  serviceType: { key: 'complaintReport.col.serviceType', def: 'Service type' },
  complaintType: { key: 'complaintReport.col.complaintType', def: 'Complaint type' },
  customerMobile: { key: 'complaintReport.col.customerMobile', def: 'Customer mobile' },
  complaintDescription: {
    key: 'complaintReport.col.complaintDescription',
    def: 'Complaint description',
  },
  responseDesc: { key: 'complaintReport.col.responseDesc', def: 'Response' },
  complaintSource: { key: 'complaintReport.col.complaintSource', def: 'Complaint source' },
  orderAmount: { key: 'complaintReport.col.orderAmount', def: 'Order amount' },
  orderNumber: { key: 'complaintReport.col.orderNumber', def: 'Order number' },
  communicationMethod: {
    key: 'complaintReport.col.communicationMethod',
    def: 'Communication method',
  },
  couponCode: { key: 'complaintReport.col.couponCode', def: 'Coupon code' },
  couponValue: { key: 'complaintReport.col.couponValue', def: 'Coupon value' },
  couponPercent: { key: 'complaintReport.col.couponPercent', def: 'Coupon %' },
  complaintStatus: { key: 'complaintReport.col.complaintStatus', def: 'Complaint status' },
  restaurantManagerId: {
    key: 'complaintReport.col.restaurantManagerId',
    def: 'Restaurant manager',
  },
  agent: { key: 'complaintReport.col.agent', def: 'Agent' },
  compensation: { key: 'complaintReport.col.compensation', def: 'Compensation' },
  lastModifiedBy: { key: 'complaintReport.col.lastModifiedBy', def: 'Last modified by' },
  lastModifiedAt: { key: 'complaintReport.col.lastModifiedAt', def: 'Last modified at' },
};

/**
 * How each column behaves in a table on screen.
 *
 * The whole sheet used to be `whitespace-nowrap`, which is right for a date or
 * a branch code and catastrophic for free text: the description column measured
 * 1081px and the response column 677px, so two of twenty-seven columns owned a
 * third of a 5085px-wide table and every other value was pushed off-screen.
 * Bounding those two brings the table back to roughly a screen and a half.
 *
 *   narrow — one line, natural width (dates, codes, names, statuses)
 *   text   — free prose: fixed width, clamped to two lines, full value on hover
 *   number — end-aligned and tabular, so magnitudes line up down the column
 *
 * This lives beside the column list rather than in the page so a column added
 * here cannot arrive on screen without a width policy.
 */
export type ComplaintColumnLayout = 'narrow' | 'text' | 'number';

export const COMPLAINT_COLUMN_LAYOUT: Record<ComplaintColumnKey, ComplaintColumnLayout> = {
  date: 'narrow',
  year: 'number',
  month: 'narrow',
  week: 'number',
  day: 'narrow',
  chain: 'narrow',
  area: 'narrow',
  brand: 'narrow',
  city: 'narrow',
  restaurantName: 'narrow',
  serviceType: 'narrow',
  complaintType: 'narrow',
  customerMobile: 'narrow',
  complaintDescription: 'text',
  responseDesc: 'text',
  complaintSource: 'narrow',
  time: 'narrow',
  orderAmount: 'number',
  orderNumber: 'narrow',
  communicationMethod: 'narrow',
  couponCode: 'narrow',
  couponValue: 'number',
  couponPercent: 'number',
  complaintStatus: 'narrow',
  restaurantManagerId: 'narrow',
  agent: 'narrow',
  compensation: 'narrow',
  lastModifiedBy: 'narrow',
  lastModifiedAt: 'narrow',
};

/**
 * A store-derived cell on a complaint row. Three states, and they must stay
 * distinguishable:
 *   no restaurant at all → blank
 *   restaurant, no store row → "Not mapped" (someone must add the store)
 *   restaurant + store row → the value, or blank if that field is simply empty
 *
 * Collapsing the middle case to a blank cell is the failure mode to avoid: it
 * reads as "this complaint had no branch" and hides a mapping gap that
 * silently skews every by-store and by-brand total.
 */
function complaintStoreCell(r: ComplaintReportRow, value: string, t: Translate): string {
  if (!r.restaurantName && !r.brand) return '';
  if (!r.storeMapped) return t('agentReports.notMapped', { defaultValue: 'Not mapped' });
  return value;
}

/**
 * One cell of the report.
 *
 * Exported because the on-screen table and the exported sheet must show the
 * same value for the same column — two separate implementations of "what goes
 * in this cell" is how a report and its export quietly start disagreeing, and
 * the person reconciling them has no way to tell which is right.
 */
export function complaintCell(
  row: ComplaintReportRow,
  key: ComplaintColumnKey,
  t: Translate,
): CellValue {
  const value: Record<ComplaintColumnKey, (r: ComplaintReportRow) => CellValue> = {
    // dd/mm/yyyy for the reader, ISO on the row. The stored value stays
    // sortable and is what filtering compares against; only the rendered cell
    // changes. Safe for the Excel round-trip because the importer already
    // accepts both forms — see `toComplaintDate`. Pivoting is unaffected: the
    // Year/Month/Week/Day columns beside this one are numbers precisely so
    // that nothing has to parse this string.
    date: (r) => isoToDmy(r.date),
    year: (r) => r.year ?? '',
    month: (r) => r.month ?? '',
    week: (r) => r.week ?? '',
    day: (r) => r.day ?? '',
    time: (r) => r.time,
    chain: (r) => complaintStoreCell(r, r.chain, t),
    area: (r) => complaintStoreCell(r, r.area, t),
    brand: (r) => complaintStoreCell(r, r.brand, t),
    city: (r) => complaintStoreCell(r, r.city, t),
    // NOT a storeCell: the branch name is the one store column worth keeping
    // even unmatched — it is what someone needs in order to FIX the mapping.
    restaurantName: (r) => r.restaurantName,
    serviceType: (r) => r.serviceType,
    complaintType: (r) => r.complaintType,
    // Text, not a number: leading zeros and a leading + are part of a mobile
    // number, and Excel eats both if the cell is numeric.
    customerMobile: (r) => r.customerMobile,
    complaintDescription: (r) => r.complaintDescription,
    responseDesc: (r) => r.responseDesc,
    complaintSource: (r) => r.complaintSource,
    orderAmount: (r) => r.orderAmount ?? '',
    orderNumber: (r) => r.orderNumber,
    communicationMethod: (r) => r.communicationMethod,
    couponCode: (r) => r.couponCode,
    couponValue: (r) => r.couponValue ?? '',
    couponPercent: (r) => r.couponPercent ?? '',
    complaintStatus: (r) => common(`status.${r.complaintStatus}`, r.complaintStatus, t),
    restaurantManagerId: () => '',
    agent: (r) => r.agent,
    compensation: (r) => compensationLabel(r, t),
    lastModifiedBy: (r) => r.lastModifiedBy,
    lastModifiedAt: (r) => r.lastModifiedAt,
  };
  return value[key](row);
}

export function buildComplaintsSheets(
  rows: ComplaintReportRow[],
  t: Translate,
  enabled?: readonly ComplaintColumnKey[],
): Sheet[] {
  const width: Record<ComplaintColumnKey, number> = {
    date: 12,
    year: 8,
    month: 8,
    week: 8,
    day: 8,
    time: 8,
    chain: 22,
    area: 22,
    brand: 16,
    city: 16,
    restaurantName: 28,
    serviceType: 14,
    complaintType: 24,
    customerMobile: 16,
    complaintDescription: 52,
    responseDesc: 44,
    complaintSource: 18,
    orderAmount: 14,
    orderNumber: 16,
    communicationMethod: 20,
    couponCode: 16,
    couponValue: 12,
    couponPercent: 10,
    complaintStatus: 24,
    restaurantManagerId: 20,
    agent: 16,
    compensation: 16,
    lastModifiedBy: 18,
    lastModifiedAt: 18,
  };
  const value = (r: ComplaintReportRow, k: ComplaintColumnKey) => complaintCell(r, k, t);

  const keys = (enabled && enabled.length ? enabled : COMPLAINT_COLUMN_KEYS).filter(
    (k): k is ComplaintColumnKey => (COMPLAINT_COLUMN_KEYS as readonly string[]).includes(k),
  );

  return [
    {
      name: t('complaintReport.tab.complaints', { defaultValue: 'Complaints' }),
      columns: keys.map((k) => ({
        header: t(COMPLAINT_COLUMN_LABELS[k].key, { defaultValue: COMPLAINT_COLUMN_LABELS[k].def }),
        width: width[k],
      })),
      rows: rows.map((r) => keys.map((k) => value(r, k))),
    },
  ];
}

/**
 * Fill the store-derived columns (chain, area, brand, city, restaurant name)
 * on complaint rows.
 *
 * Shared rather than done per page, because the manager's report and an
 * agent's must attribute a complaint to the SAME branch. If the two resolved
 * branches differently, two people reading "their" report would disagree about
 * who was responsible and neither would be able to tell which was right.
 *
 * Attribution prefers what was frozen onto the ticket when it was raised.
 * Re-resolving live would mean editing a store today rewrites who was
 * responsible for a complaint raised months ago — the report would change
 * under you with nothing to show that it had.
 */
export function joinComplaintStores(
  rows: ComplaintReportRow[],
  index: StoreIndex,
): ComplaintReportRow[] {
  return rows.map((r) => {
    // Nothing to attribute: no branch on the row and nothing frozen.
    if (!r.restaurantName && !r.brand && !r.storeSnapshot) return r;
    const { match: m } = resolveStoreAttribution(r.storeSnapshot, () =>
      matchStore(index, { restaurantName: r.restaurantName, brandName: r.brand }),
    );
    return {
      ...r,
      chain: m.chainManager,
      area: m.areaManager,
      brand: m.brandName,
      city: m.city,
      // Once matched, report the branch as the OPERATIONS master names it —
      // that is the spelling their sheet uses.
      restaurantName: m.restaurantName || r.restaurantName,
      // Not shown as columns — carried so a branch can be found by the ids
      // operations actually quote to each other.
      storeCode: m.store?.code ?? '',
      yijiRestaurantId: m.store?.yijiRestaurantId ?? '',
      storeMapped: !isUnmappedStore(m),
    };
  });
}

/** Complaints whose branch could not be resolved — each one is a store someone
 *  must add in Restaurants → Stores, so it is worth surfacing as a count. */
export function countUnmappedComplaints(rows: ComplaintReportRow[]): number {
  return rows.filter((r) => (r.restaurantName || r.brand) && !r.storeMapped).length;
}

/**
 * `Sara CRM - Complaints (last 30 days) - 2026-08-12.xlsx`
 *
 * An exported file lands in a downloads folder beside exports from every other
 * system someone uses, so it has to say what it is on its own. `base` is the
 * human subject, not a slug: "Complaints", not "reports-complaints".
 */
export function reportFilename(base: string, days: number, ext = 'xlsx'): string {
  const today = new Date().toISOString().slice(0, 10);
  const subject = base.replace(/[/:*?"<>|\\]/g, ' ').trim();
  return `Sara CRM - ${subject} (last ${days} days) - ${today}.${ext}`;
}

/** Local `YYYY-MM-DD` + `HH:mm` for a ticket's creation timestamp. */
export function splitLocalDateTime(iso: string | null | undefined): {
  date: string;
  time: string;
  year: number | null;
  month: number | null;
  week: number | null;
  day: number | null;
} {
  const blank = { date: '', time: '', year: null, month: null, week: null, day: null };
  if (!iso) return blank;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return blank;
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    // Year / Month / Week / Day are a drill-down hierarchy for pivoting, so
    // they are NUMBERS: month names sort alphabetically in Excel, which puts
    // April before January and quietly ruins every month-over-month chart.
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    week: isoWeek(d),
    day: d.getDate(),
  };
}

/**
 * ISO-8601 week number. Weeks start Monday and week 1 is the one containing
 * the first Thursday, which is what Excel's ISOWEEKNUM gives — so a week
 * number produced here lines up with one typed into the sheet by hand.
 */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Shift onto the Thursday of this week, then count weeks from Jan 1.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/* ── Finding a row ─────────────────────────────────────────────────────── */

/** Digits only — so "+966 50 123" and "050123" are the same needle. */
function digits(v: string): string {
  return v.replace(/\D+/g, '');
}

/**
 * Filter the report by one free-text box.
 *
 * Operations look a complaint up by whatever they have to hand: an order
 * number, the number the customer rang from, or a branch quoted by name, by
 * its ops code ("LCP-041") or by its Yiji restaurant id. One box that searches
 * all of them beats five labelled fields nobody can remember the order of.
 *
 * Phone matching compares DIGITS ONLY, because the same number is written
 * "+966 50 …", "0550…" and "966550…" depending on who typed it, and an exact
 * string compare finds none of the other two.
 */
export function filterComplaintRows(
  rows: readonly ComplaintReportRow[],
  query: string,
): ComplaintReportRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  const qDigits = digits(q);
  return rows.filter((r) => {
    if (r.restaurantName.toLowerCase().includes(q)) return true;
    if (r.storeCode.toLowerCase().includes(q)) return true;
    if (r.yijiRestaurantId.toLowerCase().includes(q)) return true;
    if (r.orderNumber.toLowerCase().includes(q)) return true;
    // Phone last, and only once the needle is long enough to mean something:
    // a one- or two-digit search would match almost every number on file.
    if (qDigits.length >= 3 && digits(r.customerMobile).includes(qDigits)) return true;
    return false;
  });
}

/* ── Column order ──────────────────────────────────────────────────────── */

/**
 * Move one column to a new position, returning a new order.
 *
 * Reordering is per-person preference, not a schema change: someone building a
 * pivot wants Date last, someone reading on screen wants it first. Both are
 * right, so the order is data rather than something baked into the report.
 *
 * Out-of-range indexes clamp instead of throwing — a drag that ends past the
 * end of the list is a normal gesture, not an error.
 */
export function moveColumn<T>(order: readonly T[], from: number, to: number): T[] {
  const next = [...order];
  if (from < 0 || from >= next.length) return next;
  const clamped = Math.max(0, Math.min(to, next.length - 1));
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(clamped, 0, moved);
  return next;
}

/**
 * Reconcile a saved order with the columns that exist today.
 *
 * A saved order goes stale the moment a column is added or removed. Dropping
 * unknown keys and appending new ones keeps a year-old preference working
 * instead of silently hiding a column that was added since — which is how a
 * report quietly loses a field nobody notices is missing.
 */
export function reconcileColumnOrder<T>(saved: readonly T[], all: readonly T[]): T[] {
  const known = new Set(all);
  const kept = saved.filter((k) => known.has(k));
  const seen = new Set(kept);
  return [...kept, ...all.filter((k) => !seen.has(k))];
}

/**
 * Remember a person's column arrangement.
 *
 * A preference, not data: it belongs to the browser, and losing it must never
 * break the report — hence the swallowed errors. Both portals use these so an
 * agent and an admin arrange the same report the same way.
 */
export function loadColumnOrder<T extends string>(storageKey: string): T[] {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function saveColumnOrder<T extends string>(storageKey: string, order: readonly T[]): void {
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(order));
  } catch {
    /* private mode / quota — the arrangement still applies for this session */
  }
}

/** Storage key for the ticket report's column arrangement, shared by both portals. */
export const TICKET_REPORT_ORDER_KEY = 'yiji.ticketReport.columnOrder';

/**
 * The compensation column reads "Compensated" or "Not compensated", always —
 * never blank.
 *
 * The stored field already carried those two words, but only on tickets an
 * agent had explicitly set: 47 of 99 rows were empty and the column simply
 * showed nothing, which reads as "unknown" when it is not. Measured against
 * the data, the empty rows carry ZERO coupons while every "Compensated" row
 * carries one — so an empty field means uncompensated, and saying so is the
 * accurate answer rather than a guess.
 *
 * The coupon is treated as evidence in its own right so a ticket that was
 * compensated but never had the field ticked still reports honestly. The
 * comparison is case-insensitive because the stored values are hand-entered
 * ("Not Compensated" with a capital C is in the data today).
 */
export function compensationLabel(
  row: Pick<ComplaintReportRow, 'compensation' | 'couponCode' | 'couponValue' | 'couponPercent'>,
  t: Translate,
): string {
  const stated = (row.compensation ?? '').trim().toLowerCase();
  const compensated =
    stated === 'compensated' ||
    (stated === '' &&
      (!!row.couponCode.trim() || (row.couponValue ?? 0) > 0 || (row.couponPercent ?? 0) > 0));
  return compensated
    ? common('compensation.yes', 'Compensated', t)
    : common('compensation.no', 'Not compensated', t);
}

/** `2026-08-21` → `21/08/2026`. Anything else is passed through untouched. */
function isoToDmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
