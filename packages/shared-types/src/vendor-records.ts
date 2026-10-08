/**
 * WHICH VENDOR A NEW RECORD BELONGS TO (MV-1, EMA-70).
 *
 * Since MV-1 every record the CRM writes about a vendor's customer — a coupon
 * request, a late-order decision, a branch notification — carries that vendor.
 * The writer usually knows it second-hand: from the ticket, the contact or the
 * chat the record is about. When it knows nothing (a late order comes from a
 * queue with no vendor on it yet), the record goes to the SINGLE active vendor —
 * and to nobody when there is more than one, because guessing would file one
 * vendor's coupon under another vendor.
 */

/** Anything that may carry a vendor: a bare id, or an expanded `{ id }`. */
export type VendorRef = string | { id?: string | null } | null | undefined;

/** The CRM vendor id (`vendors.id`) behind a reference, or null. */
export function vendorIdOf(ref: VendorRef): string | null {
  if (!ref) return null;
  if (typeof ref === 'string') return ref.trim() || null;
  return ref.id?.trim() || null;
}

export interface RecordVendorSources {
  /** The vendor the caller already knows (e.g. the page's sole vendor). */
  explicit?: VendorRef;
  /** The vendor of the ticket the record is about. */
  ticket?: VendorRef;
  /** The vendor of the chat the record is about. */
  conversation?: VendorRef;
  /** The vendor of the customer the record is about. */
  contact?: VendorRef;
  /**
   * Every vendor with its status — the last resort. Used ONLY when exactly one
   * is active.
   */
  vendors?: ReadonlyArray<{ id: string; status?: string | null }> | null;
}

/**
 * The vendor a new record should carry, or null when it cannot be known.
 *
 * Precedence: explicit, ticket, conversation, contact, then the single active
 * vendor. Null is an honest answer — the record is then written without a
 * vendor and reads as legacy (the Yiji vendor) until it is backfilled — and is
 * always better than a guess between two vendors.
 */
export function pickRecordVendor(src: RecordVendorSources): string | null {
  const direct =
    vendorIdOf(src.explicit) ??
    vendorIdOf(src.ticket) ??
    vendorIdOf(src.conversation) ??
    vendorIdOf(src.contact);
  if (direct) return direct;
  return soleActiveVendorId(src.vendors);
}

/** The id of the ONLY active vendor, or null when there are none or several. */
export function soleActiveVendorId(
  vendors: ReadonlyArray<{ id: string; status?: string | null }> | null | undefined,
): string | null {
  /* A row with no status predates the column default and is treated as active,
     the same reading the vendors page gives it. */
  const active = (vendors ?? []).filter((v) => v.id && (v.status ?? 'active') === 'active');
  return active.length === 1 ? active[0]!.id : null;
}

/* ── MV-4 (EMA-73): one set of agents, many vendors, data never mixed ───── */

/** The vendors that are ACTIVE (a row with no status counts as active). */
export function activeVendorsOf<T extends { id: string; status?: string | null }>(
  vendors: ReadonlyArray<T> | null | undefined,
): T[] {
  return (vendors ?? []).filter((v) => !!v.id && (v.status ?? 'active') === 'active');
}

/**
 * Whether the portals show vendor badges and vendor filters at all.
 *
 * Only when TWO OR MORE vendors are active (owner, MV-4): with one vendor a
 * badge on every chat names the only possible answer, and a filter with one
 * choice is clutter. So the whole vendor UI is invisible until a second vendor
 * goes live.
 */
export function showVendorUi(
  vendors: ReadonlyArray<{ id: string; status?: string | null }> | null | undefined,
): boolean {
  return activeVendorsOf(vendors).length >= 2;
}

/**
 * Does a vendor-SCOPED setting (a quick reply, an SLA policy) apply to a record
 * of `recordVendor`?
 *
 * The setting's own vendor NULL means "every vendor" — true for any record. A
 * setting that names a vendor applies ONLY to that vendor's records; a record
 * whose vendor is unknown is not shown to satisfy it, so it is not covered
 * (guessing would hand one vendor's wording or promise to another's customer).
 */
export function vendorScopeMatches(settingVendor: VendorRef, recordVendor: VendorRef): boolean {
  const scope = vendorIdOf(settingVendor);
  if (!scope) return true;
  return scope === vendorIdOf(recordVendor);
}

/**
 * Narrow vendor-scoped rows for a record: the rows written FOR its vendor when
 * any exist, else the all-vendor (NULL) rows. Never another vendor's rows.
 *
 * "Prefer specific, else general" rather than a union: a vendor that has its
 * own SLA policies has replaced the shared ones for itself, not added to them.
 */
export function preferVendorScoped<T extends { vendor?: VendorRef }>(
  rows: ReadonlyArray<T>,
  recordVendor: VendorRef,
): T[] {
  const id = vendorIdOf(recordVendor);
  const own = id ? rows.filter((r) => vendorIdOf(r.vendor) === id) : [];
  if (own.length > 0) return own;
  return rows.filter((r) => !vendorIdOf(r.vendor));
}
