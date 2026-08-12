import { toStoreSnapshot, type StoreMatch } from '@yiji/shared-types';
import { COMPLAINT_COLUMN_KEYS, type ComplaintColumnKey } from './complaints.js';

/**
 * Read a ticket CSV in the operations report format.
 *
 * The rule is simply "put each column where it belongs": the header names the
 * field, the cell carries the value. Everything interesting is in being
 * forgiving about how that header is spelled and how the value is typed,
 * because these files come out of Excel via several pairs of hands.
 *
 * Deliberately NOT `line.split(',')`: complaint descriptions contain commas
 * and quoted line breaks, and a naive split shifts every later column one
 * place left — the city lands in the manager field and nothing errors.
 */

/** One parsed row, keyed by report column. Values stay as written. */
export type TicketCsvRow = Partial<Record<ComplaintColumnKey, string>>;

export interface ParseTicketsResult {
  rows: TicketCsvRow[];
  /** 1-based source line + why, so a dropped row is explainable. */
  skipped: Array<{ line: number; reason: string }>;
  /** Headers we could not place, echoed back so a typo is visible. */
  unmappedHeaders: string[];
}

/** Compare headers ignoring case, spacing, underscores and punctuation. */
function foldHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Header → column. Built from the report's own columns so the two can never
 * drift, plus the spellings the historical sheet actually uses (`snake_case`
 * from the export, `Coupon %`, `Restaurant manager id`, and so on).
 */
const HEADER_ALIASES: Record<string, ComplaintColumnKey> = (() => {
  const map: Record<string, ComplaintColumnKey> = {};
  for (const k of COMPLAINT_COLUMN_KEYS) {
    map[foldHeader(k)] = k; // camelCase, e.g. "restaurantName"
    map[foldHeader(k.replace(/([A-Z])/g, ' $1'))] = k; // "Restaurant Name"
  }
  const extra: Record<string, ComplaintColumnKey> = {
    restaurant: 'restaurantName',
    restaurantname: 'restaurantName',
    store: 'restaurantName',
    branch: 'restaurantName',
    mobile: 'customerMobile',
    phone: 'customerMobile',
    customermobile: 'customerMobile',
    customerphone: 'customerMobile',
    description: 'complaintDescription',
    complaintdescription: 'complaintDescription',
    response: 'responseDesc',
    responsedesc: 'responseDesc',
    responsedescription: 'responseDesc',
    source: 'complaintSource',
    complaintsource: 'complaintSource',
    status: 'complaintStatus',
    complaintstatus: 'complaintStatus',
    ordernumber: 'orderNumber',
    orderno: 'orderNumber',
    orderamount: 'orderAmount',
    amount: 'orderAmount',
    couponpercent: 'couponPercent',
    coupon: 'couponCode',
    couponcode: 'couponCode',
    couponvalue: 'couponValue',
    communicationmethod: 'communicationMethod',
    servicetype: 'serviceType',
    complainttype: 'complaintType',
    restaurantmanagerid: 'restaurantManagerId',
    restaurantmanager: 'restaurantManagerId',
    chainmanager: 'chain',
    areamanager: 'area',
  };
  return { ...map, ...extra };
})();

/** Split one CSV line, honouring double quotes and "" escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Rows, honouring quoted fields that span lines. */
function splitRecords(text: string): string[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      records.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) records.push(cur);
  return records;
}

/**
 * A cell that means "nothing". The historical sheet writes an empty column as
 * `-`, and importing that literally would put a hyphen in the order number.
 */
export function isBlankCell(v: string): boolean {
  const s = v.trim();
  return s === '' || s === '-' || s === '—' || s === 'N/A' || s === 'n/a';
}

export function parseTicketsCsv(text: string): ParseTicketsResult {
  const records = splitRecords(text).filter((r) => r.trim() !== '');
  const skipped: ParseTicketsResult['skipped'] = [];
  const unmappedHeaders: string[] = [];
  if (records.length === 0) return { rows: [], skipped, unmappedHeaders };

  const header = splitCsvLine(records[0]!);
  const colOf = header.map((h) => {
    const key = HEADER_ALIASES[foldHeader(h)];
    if (!key && h.trim()) unmappedHeaders.push(h.trim());
    return key ?? null;
  });

  const rows: TicketCsvRow[] = [];
  records.slice(1).forEach((rec, i) => {
    const line = i + 2; // 1-based, header is line 1
    const cells = splitCsvLine(rec);
    const row: TicketCsvRow = {};
    colOf.forEach((key, c) => {
      if (!key) return;
      const raw = (cells[c] ?? '').trim();
      if (isBlankCell(raw)) return;
      row[key] = raw;
    });
    // A row with nothing in it is Excel's trailing blank, not a complaint.
    if (Object.keys(row).length === 0) {
      skipped.push({ line, reason: 'empty row' });
      return;
    }
    rows.push(row);
  });

  return { rows, skipped, unmappedHeaders };
}

/** `2026-03-14` + `19:11` → an ISO instant, or null if the date is unusable. */
export function toComplaintDate(date?: string, time?: string): string | null {
  if (!date) return null;
  const d = date.trim();
  // Accept both 2026-03-14 and 14/03/2026, which is how Excel exports here.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(d);
  const dmy = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(d);
  let y: number, m: number, day: number;
  if (iso) [, y, m, day] = [0, +iso[1]!, +iso[2]!, +iso[3]!];
  else if (dmy) [, day, m, y] = [0, +dmy[1]!, +dmy[2]!, +dmy[3]!];
  else return null;

  // Times arrive as H:MM and HH:MM:SS; anything else is treated as midnight
  // rather than rejecting an otherwise good row over a broken clock value.
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((time ?? '').trim());
  const hh = tm ? +tm[1]! : 0;
  const mm = tm ? +tm[2]! : 0;
  const dt = new Date(y, m - 1, day, hh, mm);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** Numeric cell that tolerates "102.85 SR", "1,200" and a stray currency sign. */
export function toNumberCell(v?: string): number | null {
  if (!v || isBlankCell(v)) return null;
  const m = /-?\d+(\.\d+)?/.exec(v.replace(/,/g, ''));
  return m ? Number(m[0]) : null;
}

/* ── CSV row → ticket ──────────────────────────────────────────────────── */

/** What the caller has already resolved for this row. */
export interface TicketPayloadContext {
  /** The branch this row was matched to, however it was matched. */
  store: StoreMatch;
  /** Existing or newly created contact for the customer's number. */
  contactId?: string | null;
  vendorId?: string | null;
  /** Directus user id for the agent named in the sheet, when recognised. */
  agentId?: string | null;
  /** ISO instant for the complaint itself, from `toComplaintDate`. */
  complaintDate?: string | null;
  /** When the branch attribution was frozen. */
  capturedAt: string;
}

/**
 * Turn one parsed CSV row into a ticket ready to insert.
 *
 * Pure and shared, because two callers need exactly this mapping — the import
 * button in the agent portal and the seeding script — and a second copy would
 * drift until an imported ticket and a seeded one described the same complaint
 * differently.
 *
 * Resolution of the branch, customer and agent happens in the caller: those
 * need the database, and keeping them out is what makes this testable.
 */
export function ticketPayloadFromCsvRow(
  row: TicketCsvRow,
  ctx: TicketPayloadContext,
): Record<string, unknown> {
  const branch = (row.restaurantName ?? '').trim();
  const orderNumber = (row.orderNumber ?? '').trim();
  const orderAmount = toNumberCell(row.orderAmount);

  return {
    // The sheet has no subject column, and a blank one fails the required
    // field. The complaint type is what operations would call it anyway.
    subject: row.complaintType || row.complaintDescription?.slice(0, 80) || 'Imported complaint',
    description: row.complaintDescription ?? null,
    // Every historical row is "Closed - Customer Satisfied"; these are records
    // of handled complaints, not live work arriving in someone's queue.
    status: 'closed',
    ...(ctx.complaintDate ? { complaint_date: ctx.complaintDate } : {}),
    ...(ctx.contactId ? { contact: ctx.contactId } : {}),
    ...(ctx.vendorId ? { vendor: ctx.vendorId } : {}),
    ...(ctx.store.store ? { store: ctx.store.store.id } : {}),
    // Frozen exactly as a ticket raised in the portal freezes it, so editing a
    // store later cannot rewrite what this row reports.
    store_snapshot: toStoreSnapshot(ctx.store, ctx.capturedAt),
    ...(orderNumber || orderAmount !== null
      ? {
          // The FULL snapshot shape, not just the fields the sheet happens to
          // carry. The order card reduces over `items` and formats `total`, so
          // a partial object crashes the ticket page — the sheet has no line
          // items, and an empty list is the honest way to say so.
          order_snapshot: {
            orderId: orderNumber,
            status: '',
            total: orderAmount ?? 0,
            currency: 'SAR',
            placedAt: ctx.complaintDate ?? '',
            items: [],
            brandName: row.brand ?? null,
            restaurantName: branch || null,
            capturedAt: ctx.capturedAt,
          },
        }
      : {}),
    complaint_type: row.complaintType ?? null,
    service_type: row.serviceType ?? null,
    complaint_source: row.complaintSource ?? null,
    communication_method: row.communicationMethod ?? null,
    response_desc: row.responseDesc ?? null,
    compensation: row.compensation ?? null,
    coupon_code: row.couponCode ?? null,
    coupon_value: toNumberCell(row.couponValue),
    coupon_percent: toNumberCell(row.couponPercent),
    ...(ctx.agentId ? { assigned_agent: ctx.agentId } : {}),
  };
}
