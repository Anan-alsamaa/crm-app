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
  /** Local `HH:mm` of ticket creation. */
  time: string;
  /** Chain manager, from the matched store. */
  chain: string;
  /** Area manager, from the matched store. */
  area: string;
  brand: string;
  city: string;
  restaurantName: string;
  /** False when no store row matched — rendered as "Not mapped", never blank. */
  storeMapped: boolean;
  serviceType: string;
  complaintType: string;
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
export const COMPLAINT_COLUMN_KEYS = [
  'date',
  'time',
  'chain',
  'area',
  'brand',
  'city',
  'restaurantName',
  'serviceType',
  'complaintType',
  'customerName',
  'customerMobile',
  'complaintDescription',
  'responseDesc',
  'complaintSource',
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
] as const;
export type ComplaintColumnKey = (typeof COMPLAINT_COLUMN_KEYS)[number];

export const COMPLAINT_COLUMN_LABELS: Record<ComplaintColumnKey, { key: string; def: string }> = {
  date: { key: 'complaintReport.col.date', def: 'Date' },
  time: { key: 'complaintReport.col.time', def: 'Time' },
  chain: { key: 'complaintReport.col.chain', def: 'Chain' },
  area: { key: 'complaintReport.col.area', def: 'Area' },
  brand: { key: 'complaintReport.col.brand', def: 'Brand' },
  city: { key: 'complaintReport.col.city', def: 'City' },
  restaurantName: { key: 'complaintReport.col.restaurantName', def: 'Restaurant name' },
  serviceType: { key: 'complaintReport.col.serviceType', def: 'Service type' },
  complaintType: { key: 'complaintReport.col.complaintType', def: 'Complaint type' },
  customerName: { key: 'complaintReport.col.customerName', def: 'Customer name' },
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
    def: 'Restaurant manager ID',
  },
  agent: { key: 'complaintReport.col.agent', def: 'Agent' },
  compensation: { key: 'complaintReport.col.compensation', def: 'Compensation' },
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

export function buildComplaintsSheets(
  rows: ComplaintReportRow[],
  t: Translate,
  enabled?: readonly ComplaintColumnKey[],
): Sheet[] {
  const width: Record<ComplaintColumnKey, number> = {
    date: 12,
    time: 8,
    chain: 22,
    area: 22,
    brand: 16,
    city: 16,
    restaurantName: 28,
    serviceType: 14,
    complaintType: 24,
    customerName: 20,
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
  };
  const value: Record<ComplaintColumnKey, (r: ComplaintReportRow) => CellValue> = {
    date: (r) => r.date,
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
    customerName: (r) => r.customerName,
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
    compensation: (r) => r.compensation,
  };

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
      rows: rows.map((r) => keys.map((k) => value[k](r))),
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
      storeMapped: !isUnmappedStore(m),
    };
  });
}

/** Complaints whose branch could not be resolved — each one is a store someone
 *  must add in Restaurants → Stores, so it is worth surfacing as a count. */
export function countUnmappedComplaints(rows: ComplaintReportRow[]): number {
  return rows.filter((r) => (r.restaurantName || r.brand) && !r.storeMapped).length;
}

/** `reports-complaints-30d-2026-08-12.xlsx` — shared so both portals' exports
 *  land in a downloads folder under the same naming. */
export function reportFilename(base: string, days: number): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${base}-${days}d-${today}.xlsx`;
}

/** Local `YYYY-MM-DD` + `HH:mm` for a ticket's creation timestamp. */
export function splitLocalDateTime(iso: string | null | undefined): {
  date: string;
  time: string;
} {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}
