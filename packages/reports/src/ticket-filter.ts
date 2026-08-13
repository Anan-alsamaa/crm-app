/**
 * One filter, used by BOTH the agent's ticket queue and the manager's ticket
 * report.
 *
 * Two implementations of "find the ticket about order 946641" is two places for
 * it to be subtly different, and the two audiences ask the same questions —
 * the agent about their own queue, the manager about everyone's. So it lives
 * here, beside the report columns it filters on.
 *
 * Every criterion is optional and they AND together; an empty criteria object
 * returns everything. Nothing here mutates the input.
 */

/** The fields the filter reads. Structural, so both row shapes satisfy it. */
export interface FilterableTicketRow {
  date: string;
  complaintType: string;
  customerMobile: string;
  orderNumber: string;
  restaurantName: string;
  complaintDescription: string;
  responseDesc: string;
  complaintStatus: string;
  agent: string;
  brand: string;
  city: string;
  serviceType: string;
  complaintSource: string;
  compensation: string;
  /** Present on the report row; absent on the agent's. */
  storeCode?: string;
  yijiRestaurantId?: string;
}

export interface TicketFilterCriteria {
  /**
   * Free text. Matched against the order number, the phone, the branch and its
   * codes, and the two prose fields — one box rather than five, because an
   * agent with a number in front of them should not first have to decide WHICH
   * kind of number it is.
   */
  query?: string;
  /** Exact match on the agreed vocabulary. */
  complaintType?: string;
  status?: string;
  agent?: string;
  brand?: string;
  city?: string;
  serviceType?: string;
  source?: string;
  compensation?: string;
  /** Inclusive `YYYY-MM-DD` bounds on the row's local calendar date. */
  from?: string;
  to?: string;
}

const digits = (s: string): string => s.replace(/\D+/g, '');

const eq = (value: string, want: string | undefined): boolean =>
  !want || value.trim().toLowerCase() === want.trim().toLowerCase();

/** True when `row` satisfies every supplied criterion. */
export function matchesTicketFilter(
  row: FilterableTicketRow,
  criteria: TicketFilterCriteria,
): boolean {
  if (!eq(row.complaintType, criteria.complaintType)) return false;
  if (!eq(row.complaintStatus, criteria.status)) return false;
  if (!eq(row.agent, criteria.agent)) return false;
  if (!eq(row.brand, criteria.brand)) return false;
  if (!eq(row.city, criteria.city)) return false;
  if (!eq(row.serviceType, criteria.serviceType)) return false;
  if (!eq(row.complaintSource, criteria.source)) return false;
  if (!eq(row.compensation, criteria.compensation)) return false;

  // String comparison is correct here and cheaper than parsing: `date` is
  // already the row's LOCAL calendar day in YYYY-MM-DD, and the bounds are the
  // same shape from a date input. Parsing both into Date objects is how a
  // timezone gets reintroduced into a comparison that has none.
  if (criteria.from && (!row.date || row.date < criteria.from)) return false;
  if (criteria.to && (!row.date || row.date > criteria.to)) return false;

  const q = criteria.query?.trim().toLowerCase();
  if (!q) return true;

  if (row.orderNumber.toLowerCase().includes(q)) return true;
  if (row.restaurantName.toLowerCase().includes(q)) return true;
  if ((row.storeCode ?? '').toLowerCase().includes(q)) return true;
  if ((row.yijiRestaurantId ?? '').toLowerCase().includes(q)) return true;
  if (row.complaintType.toLowerCase().includes(q)) return true;
  if (row.complaintDescription.toLowerCase().includes(q)) return true;
  if (row.responseDesc.toLowerCase().includes(q)) return true;
  // Phone last, and only once the needle is long enough to mean something: a
  // one- or two-digit search would match almost every number on file.
  const qDigits = digits(q);
  if (qDigits.length >= 3 && digits(row.customerMobile).includes(qDigits)) return true;
  return false;
}

export function filterTickets<T extends FilterableTicketRow>(
  rows: readonly T[],
  criteria: TicketFilterCriteria,
): T[] {
  return rows.filter((r) => matchesTicketFilter(r, criteria));
}

/** True when nothing is being filtered — used to label "showing all". */
export function isEmptyFilter(criteria: TicketFilterCriteria): boolean {
  return !Object.values(criteria).some((v) => typeof v === 'string' && v.trim() !== '');
}

/**
 * The distinct values present in `rows` for one field, sorted, blanks dropped.
 *
 * Dropdowns are built from the DATA rather than from the enum on purpose: a
 * filter listing thirty complaint types when the range holds four is a menu the
 * user has to read past, and picking one of the twenty-six absent ones returns
 * an empty table that looks like a bug.
 */
export function distinctValues<T extends FilterableTicketRow>(
  rows: readonly T[],
  field: keyof FilterableTicketRow,
): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const v = (r[field] ?? '').toString().trim();
    if (v) seen.add(v);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
