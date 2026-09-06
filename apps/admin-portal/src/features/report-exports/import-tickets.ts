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
 * A row's identity.
 *
 * Tickets carry no import reference column, so identity has to come from what
 * IS stored. Complaint instant + order number + the opening of the description
 * is what distinguishes two complaints in a sheet, and it can be rebuilt from
 * rows already in the database — which is what makes a re-import safe rather
 * than a way to double everything.
 */
export function ticketIdentity(
  complaintDate: string | null,
  orderId: string,
  description: string,
): string {
  return `${complaintDate ?? ''}|${orderId}|${description.slice(0, 60)}`;
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
  const seen = new Set(ctx.existing);
  const create: PlannedTicket[] = [];
  const skipped: ImportPlan['skipped'] = [];
  const capturedAt = new Date().toISOString();
  let duplicates = 0;
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

    const ref = ticketIdentity(
      complaintDate,
      String(row.orderNumber ?? ''),
      String(row.complaintDescription ?? ''),
    );
    // Catches both rows already in the database and rows repeated in the sheet.
    if (seen.has(ref)) {
      duplicates += 1;
      return;
    }
    seen.add(ref);

    const match = matchStore(ctx.index, {
      restaurantName: row.restaurantName ?? null,
      brandName: row.brand ?? null,
    });
    if (!match.store) unmatchedStores += 1;

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

    create.push({ ref, phone, via: match.via, payload });
  });

  const newContacts = new Set(
    create.filter((p) => p.phone && !ctx.contactByPhone.has(p.phone)).map((p) => p.phone!),
  ).size;

  return {
    parsed: rows.length,
    create,
    duplicates,
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
  for (let i = 0; i < missing.length; i += BATCH) {
    const made = await deps.createContacts(missing.slice(i, i + BATCH));
    for (const [phone, id] of made) {
      contactByPhone.set(phone, id);
      contactsCreated += 1;
    }
  }

  // Now that the contacts exist, point each ticket at its own.
  for (const p of plan.create) {
    if (p.phone && contactByPhone.has(p.phone)) p.payload.contact = contactByPhone.get(p.phone);
  }

  let created = 0;
  let failed = 0;
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
        } catch {
          failed += 1;
        }
      }
    }
    deps.onProgress?.(created + failed, plan.create.length);
  }

  return { created, contactsCreated, failed };
}
