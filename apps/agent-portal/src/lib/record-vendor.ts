import { readItem, readItems } from '@directus/sdk';
import { pickRecordVendor, vendorIdOf, type VendorRef } from '@yiji/shared-types';
import { directus } from './directus.js';

/**
 * THE VENDOR A NEW RECORD CARRIES (MV-1, EMA-70).
 *
 * Coupon requests, late-order decisions and branch notifications are written
 * from this portal straight into Directus, so this is where they learn their
 * vendor: from what the caller already knows, else the ticket / chat /
 * customer the record is about, else the single active vendor. `null` when
 * none of those answers — the record is then written without a vendor and
 * reads as legacy (Yiji) until backfilled, which is better than a guess.
 *
 * NEVER THROWS. A record must not fail to save because its vendor could not
 * be looked up: every read here is best-effort.
 */
export interface RecordVendorHints {
  explicit?: VendorRef;
  ticket?: string | null;
  conversation?: string | null;
  contact?: string | null;
}

const VENDORS_TTL_MS = 5 * 60_000;
let vendorsCache: {
  at: number;
  rows: Promise<Array<{ id: string; status?: string | null }>>;
} | null = null;

function activeVendors(): Promise<Array<{ id: string; status?: string | null }>> {
  if (!vendorsCache || Date.now() - vendorsCache.at > VENDORS_TTL_MS) {
    const rows = (
      directus.request(readItems('vendors', { fields: ['id', 'status'], limit: -1 })) as Promise<
        Array<{ id: string; status?: string | null }>
      >
    ).catch(() => {
      vendorsCache = null; // do not remember a failure
      return [];
    });
    vendorsCache = { at: Date.now(), rows };
  }
  return vendorsCache.rows;
}

async function vendorOf(
  collection: 'tickets' | 'conversations' | 'contacts',
  id: string | null | undefined,
): Promise<string | null> {
  if (!id) return null;
  try {
    const row = (await directus.request(
      readItem(collection as never, id, { fields: ['vendor'] } as never),
    )) as unknown as { vendor?: VendorRef } | null;
    return vendorIdOf(row?.vendor);
  } catch {
    return null;
  }
}

export async function resolveRecordVendor(hints: RecordVendorHints): Promise<string | null> {
  const explicit = vendorIdOf(hints.explicit);
  if (explicit) return explicit;
  const ticket = await vendorOf('tickets', hints.ticket);
  if (ticket) return ticket;
  const conversation = await vendorOf('conversations', hints.conversation);
  if (conversation) return conversation;
  const contact = await vendorOf('contacts', hints.contact);
  if (contact) return contact;
  return pickRecordVendor({ vendors: await activeVendors() });
}

/** The record fields to spread into a create: `{ vendor }`, or nothing. */
export async function vendorField(hints: RecordVendorHints): Promise<{ vendor?: string }> {
  const vendor = await resolveRecordVendor(hints);
  return vendor ? { vendor } : {};
}

/** Test hook: forget the cached vendors list. */
export function resetRecordVendorCache(): void {
  vendorsCache = null;
}
