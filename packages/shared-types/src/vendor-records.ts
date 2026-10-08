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
