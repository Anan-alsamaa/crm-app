/**
 * Turning a chosen spreadsheet into tickets.
 *
 * The parsing already exists and is shared (`@yiji/reports`): this is the half
 * that needs the database — resolving each row's branch, customer and agent,
 * and refusing the rows it cannot honestly place.
 *
 * WHY A PLAN, RATHER THAN JUST IMPORTING
 *
 * A sheet is 1,600 rows more often than 5, and every mistake in it lands as a
 * ticket somebody then has to find and delete one at a time. So nothing is
 * written until the caller has seen what WOULD be written: how many rows are
 * new, how many are already loaded, how many resolve to a real branch, and
 * which rows are being skipped and why. `planImport` answers that; `runImport`
 * carries it out.
 *
 * The rules encoded here were not invented — they came out of loading the real
 * 1,673-row operations sheet, where each one was a row that would otherwise
 * have landed wrong.
 */
import {
  parseTicketsCsv,
  parseTicketsXlsx,
  ticketPayloadFromCsvRow,
  toComplaintDate,
  type ParseTicketsResult,
  type TicketCsvRow,
} from '@yiji/reports';
import { matchStore, normalizePhone, type StoreIndex, type StoreMatch } from '@yiji/shared-types';

/** A row that will be created, with everything already resolved. */
export interface PlannedTicket {
  /** Stable identity for the row, so a re-import does not duplicate it. */
  ref: string;
  /** The sheet line it came from, so a failure can name the row to fix. */
  line: number;
  /** Canonical `05XXXXXXXX`, or null when the sheet's number is unusable. */
  phone: string | null;
  /** How the branch was resolved — surfaced so gaps are visible, not guessed. */
  via: StoreMatch['via'];
  payload: Record<string, unknown>;
}

export interface ImportPlan {
  /** Rows the parser could read at all. */
  parsed: number;
  /** Ready to create. */
  create: PlannedTicket[];
  /** Already in the database (or repeated within the sheet). */
  duplicates: number;
  /** Of those, rows already in the DATABASE — a re-import, safely skipped. */
  alreadyLoaded: number;
  /**
   * Of those, rows the SHEET itself repeats exactly, each with the line of its
   * first copy — a different thing from "already loaded", and named apart so
   * nobody reads a sheet's own repetition as an earlier import.
   */
  repeatedInSheet: Array<{ line: number; firstLine: number }>;
  /** Rows dropped, with the reason, so nothing disappears silently. */
  skipped: Array<{ line: number; reason: string }>;
  /** Headers the parser could not place — usually a typo in the sheet. */
  unmappedHeaders: string[];
  /** Rows whose branch matched nothing; they import as "Not mapped". */
  unmatchedStores: number;
  /** Distinct phone numbers with no contact yet. */
  newContacts: number;
}

/**
 * A row's identity, built from what a ticket STORES.
 *
 * Tickets carry no import reference column, so identity has to come from the
 * stored fields — which is what lets a re-import recognise its own rows rather
 * than doubling them.
 *
 * It used to be complaint instant + order number + the first 60 characters of
 * the description. The 2026-10-05 history import showed that is too little:
 * 9 pairs of DIFFERENT complaints shared all three and differed only in the
 * coupon, its value, the agent, the compensation or how the customer got in
 * touch — and the second of each pair was dropped as a "duplicate" (EMA-43).
 * So every stored field that can tell two complaints apart is in it now.
 *
 * NORMALISED so a value read back from the database matches the one about to
 * be written: the instant to its first 19 characters (the database and the
 * parser disagree about `Z` and milliseconds, not about the moment), numbers
 * as numbers (`"9.00000"` and `9` are the same coupon), text trimmed.
 */
export interface TicketIdentityFields {
  complaint_date: string | null;
  order_id?: string | null;
  description?: string | null;
  coupon_code?: string | null;
  coupon_value?: number | string | null;
  coupon_percent?: number | string | null;
  compensation?: string | null;
  communication_method?: string | null;
  response_desc?: string | null;
  assigned_agent?: string | null;
}

/** The stored fields `ticketIdentity` reads — the import's own query asks for exactly these. */
export const TICKET_IDENTITY_FIELDS = [
  'complaint_date',
  'order_id',
  'description',
  'coupon_code',
  'coupon_value',
  'coupon_percent',
  'compensation',
  'communication_method',
  'response_desc',
  'assigned_agent',
] as const;

function idText(v: unknown): string {
  return v == null ? '' : String(v).trim();
}
function idNumber(v: unknown): string {
  if (v == null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : idText(v);
}

export function ticketIdentity(t: TicketIdentityFields): string {
  return [
    idText(t.complaint_date).slice(0, 19),
    idText(t.order_id),
    idText(t.description),
    idText(t.coupon_code),
    idNumber(t.coupon_value),
    idNumber(t.coupon_percent),
    idText(t.compensation),
    idText(t.communication_method),
    idText(t.response_desc),
    idText(t.assigned_agent),
  ].join('|');
}

/** Read whichever of the two formats the file actually is. */
export async function parseTicketFile(file: File): Promise<ParseTicketsResult> {
  const isXlsx = /\.xlsx$/i.test(file.name);
  return isXlsx ? parseTicketsXlsx(await file.arrayBuffer()) : parseTicketsCsv(await file.text());
}

export interface PlanContext {
  index: StoreIndex;
  /** Identities already in the database, from `ticketIdentity`. */
  existing: ReadonlySet<string>;
  /** phone (canonical) → contact id. */
  contactByPhone: ReadonlyMap<string, string>;
  /** lowercased first name → Directus user id. */
  agentByName: ReadonlyMap<string, string>;
  vendorId: string | null;
}

/**
 * The canonical stored form. Anything else is refused a contact rather than
 * minting one nobody can dial: the real sheet contained an 18-digit paste that
 * `normalizePhone` passes through untouched, because it cannot tell a corrupt
 * number from an unfamiliar one. The complaint is still real, so the TICKET is
 * kept; only the customer link is withheld.
 */
const SAUDI_MOBILE = /^05\d{8}$/;

export function planImport(rows: readonly TicketCsvRow[], ctx: PlanContext): ImportPlan {
  const create: PlannedTicket[] = [];
  const skipped: ImportPlan['skipped'] = [];
  const capturedAt = new Date().toISOString();
  let alreadyLoaded = 0;
  const repeatedInSheet: ImportPlan['repeatedInSheet'] = [];
  /** identity -> the sheet line that first carried it. */
  const firstLineOf = new Map<string, number>();
  let unmatchedStores = 0;

  rows.forEach((row, i) => {
    const line = i + 2; // 1-based, and the header is line 1.
    const complaintDate = toComplaintDate(row.date, row.time);

    /*
     * A complaint with no usable date cannot be reported on: every cut in this
     * report is by date, so such a row would exist and appear nowhere. Better
     * refused at the door, named, than loaded into a blind spot.
     */
    if (!complaintDate) {
      skipped.push({ line, reason: 'no usable date' });
      return;
    }

    const match = matchStore(ctx.index, {
      restaurantName: row.restaurantName ?? null,
      brandName: row.brand ?? null,
    });
    /* Counted only once the row is known to be new — see below. */
    const unmatched = !match.store;

    const raw = row.customerMobile ? normalizePhone(row.customerMobile) : null;
    const phone = raw && SAUDI_MOBILE.test(raw) ? raw : null;

    const payload = ticketPayloadFromCsvRow(row, {
      store: match,
      contactId: phone ? (ctx.contactByPhone.get(phone) ?? null) : null,
      vendorId: ctx.vendorId,
      agentId:
        ctx.agentByName.get(
          String(row.agent ?? '')
            .trim()
            .toLowerCase(),
        ) ?? null,
      complaintDate,
      capturedAt,
    });
    // Persist the order number so this row's identity can be rebuilt later.
    if (row.orderNumber) payload.order_id = String(row.orderNumber).trim();

    /*
     * Identity from the PAYLOAD — exactly what will be stored — so it is built
     * the same way as the identities read back from the database.
     */
    const ref = ticketIdentity(payload as unknown as TicketIdentityFields);
    if (ctx.existing.has(ref)) {
      alreadyLoaded += 1;
      return;
    }
    const first = firstLineOf.get(ref);
    if (first !== undefined) {
      repeatedInSheet.push({ line, firstLine: first });
      return;
    }
    firstLineOf.set(ref, line);
    if (unmatched) unmatchedStores += 1;

    create.push({ ref, line, phone, via: match.via, payload });
  });

  const newContacts = new Set(
    create.filter((p) => p.phone && !ctx.contactByPhone.has(p.phone)).map((p) => p.phone!),
  ).size;

  return {
    parsed: rows.length,
    create,
    duplicates: alreadyLoaded + repeatedInSheet.length,
    alreadyLoaded,
    repeatedInSheet,
    skipped,
    unmappedHeaders: [],
    unmatchedStores,
    newContacts,
  };
}

export interface ImportResult {
  created: number;
  contactsCreated: number;
  failed: number;
  /**
   * EVERY refused row, by sheet line, with the server's own reason.
   *
   * Only a count used to come back, so a partial import said "12 refused" and
   * left nobody able to find or fix the twelve (EMA-43).
   */
  failures: Array<{ line: number; reason: string }>;
  /** Customers that could not be created; their tickets import without the link. */
  contactsFailed: number;
}

/** A Directus rejection is a plain object with an `errors` array, not an Error. */
export function describeImportError(err: unknown): string {
  const e = err as { errors?: Array<{ message?: string }>; message?: string } | null;
  return e?.errors?.[0]?.message ?? e?.message ?? String(err);
}

export interface RunImportDeps {
  /** Create contacts, returning phone → id for what was made. */
  createContacts: (phones: string[]) => Promise<Map<string, string>>;
  /** Create one batch of tickets. Rejects if the batch could not be written. */
  createTickets: (payloads: Array<Record<string, unknown>>) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

/** How many rows go in one request. Small enough to survive a URL/body limit. */
const BATCH = 50;

export async function runImport(
  plan: ImportPlan,
  deps: RunImportDeps,
  contactByPhone: Map<string, string>,
): Promise<ImportResult> {
  // Contacts FIRST: a ticket references one, and a ticket written before its
  // contact exists loses the customer link for good.
  const missing = [
    ...new Set(
      plan.create.filter((p) => p.phone && !contactByPhone.has(p.phone)).map((p) => p.phone!),
    ),
  ];
  let contactsCreated = 0;
  let contactsFailed = 0;
  const keep = (made: Map<string, string>) => {
    for (const [phone, id] of made) {
      contactByPhone.set(phone, id);
      contactsCreated += 1;
    }
  };
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    try {
      keep(await deps.createContacts(chunk));
    } catch {
      /*
       * One bad number must not abort the import. It used to: a failed
       * contacts batch threw out of here AFTER earlier batches were written,
       * leaving a half-loaded import and no tickets at all. Retry singly; a
       * customer that still cannot be created costs only that ticket's
       * customer link, never the ticket.
       */
      for (const phone of chunk) {
        try {
          keep(await deps.createContacts([phone]));
        } catch {
          contactsFailed += 1;
        }
      }
    }
  }

  // Now that the contacts exist, point each ticket at its own.
  for (const p of plan.create) {
    if (p.phone && contactByPhone.has(p.phone)) p.payload.contact = contactByPhone.get(p.phone);
  }

  let created = 0;
  let failed = 0;
  const failures: ImportResult['failures'] = [];
  for (let i = 0; i < plan.create.length; i += BATCH) {
    const batch = plan.create.slice(i, i + BATCH);
    try {
      await deps.createTickets(batch.map((p) => p.payload));
      created += batch.length;
    } catch {
      /*
       * One bad row must not cost the other 49. Retry the batch singly so the
       * import delivers everything that CAN be written, and the rest is
       * counted rather than silently lost.
       */
      for (const p of batch) {
        try {
          await deps.createTickets([p.payload]);
          created += 1;
        } catch (err) {
          failed += 1;
          failures.push({ line: p.line, reason: describeImportError(err) });
        }
      }
    }
    deps.onProgress?.(created + failed, plan.create.length);
  }

  return { created, contactsCreated, failed, failures, contactsFailed };
}
