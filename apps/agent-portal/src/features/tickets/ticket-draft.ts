import type { CouponRequestDraft, Priority } from '@yiji/shared-types';
import type { ContactRow } from '../contacts/api.js';
import type { ComplaintValues } from './ComplaintFields.js';

/**
 * THE ADD-TICKET FORM SURVIVES LEAVING THE PAGE (owner, 2026-10-07).
 *
 * "I added some data in the Add ticket page ... went to some other page ... the
 * ticket entered must be retained when I come back to it." The form lived in
 * component state, so any trip to another route — checking the inbox while the
 * customer was still on the phone — threw the half-typed ticket away.
 *
 * sessionStorage, not localStorage, for the same reason the session itself is
 * per-tab (see `lib/directus.ts`): two agents can share one machine, and a
 * draft is scratch work for the shift in progress, not something to resurrect
 * days later in somebody else's tab. It survives in-app navigation AND a
 * reload of the same tab, which is exactly the ask.
 *
 * Keyed per signed-in user AND per conversation, so a ticket started from one
 * chat can never appear pre-filled on another chat's form, nor on the
 * standalone page.
 *
 * Two writers share one record: the page owns the chosen CONTACT (standalone
 * only) and the form owns everything else. `writeTicketDraft` merges, and the
 * record disappears once both halves are empty — so a blank form never shows
 * "Draft restored".
 *
 * Only what the agent typed or chose is kept. Files cannot be stored here, and
 * this form never uploads its own — chat files are attached by reference from
 * the conversation, which is why only the include toggle is remembered.
 */

const PREFIX = 'yiji.agent.ticketDraft';
const VERSION = 1;

/** What the form itself remembers. Plain JSON — every field is a primitive. */
export interface TicketFormDraft {
  description: string;
  priority: Priority;
  complaint: ComplaintValues;
  typedOrderId: string;
  lookupId: string;
  storeId: string;
  assignCoupon: boolean;
  collectedCoupon: CouponRequestDraft | null;
  includeOrder: boolean;
  includeFiles: boolean;
}

/**
 * The picked customer, trimmed to what the picker and the form read. The
 * contact's free-form `metadata` and tags are deliberately NOT copied into the
 * browser: the form never shows them, and the less of a customer record that
 * sits in storage, the better.
 */
export type TicketDraftContact = Pick<
  ContactRow,
  'id' | 'name' | 'phone' | 'email' | 'vendor' | 'external_customer_id' | 'date_created'
>;

export interface TicketDraft {
  v: typeof VERSION;
  savedAt: string;
  form?: TicketFormDraft | null;
  contact?: TicketDraftContact | null;
}

/**
 * The storage key, or null when there is nobody signed in to own a draft — in
 * which case nothing is read or written at all.
 */
export function ticketDraftKey(
  userId: string | null | undefined,
  conversationId: string | null | undefined,
): string | null {
  if (!userId) return null;
  return `${PREFIX}.${userId}.${conversationId ? `chat.${conversationId}` : 'standalone'}`;
}

export function readTicketDraft(key: string | null): TicketDraft | null {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TicketDraft> | null;
    // A draft from an older shape of the form is dropped rather than half-read
    // into fields that no longer mean the same thing.
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION) return null;
    return parsed as TicketDraft;
  } catch {
    // Private mode, quota, or a corrupt value: behave as if there is no draft
    // rather than taking the form down with us.
    return null;
  }
}

/** Merge `patch` into the stored draft; removes it once nothing is left. */
export function writeTicketDraft(
  key: string | null,
  patch: Partial<Pick<TicketDraft, 'form' | 'contact'>>,
): void {
  if (!key) return;
  try {
    const current = readTicketDraft(key);
    const next: TicketDraft = {
      v: VERSION,
      savedAt: new Date().toISOString(),
      form: current?.form ?? null,
      contact: current?.contact ?? null,
      ...patch,
    };
    if (!next.form && !next.contact) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* best effort: a convenience, never the source of truth */
  }
}

export function clearTicketDraft(key: string | null): void {
  if (!key) return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

/** The picked contact, reduced to what is safe and useful to keep. */
export function toDraftContact(c: ContactRow | null): TicketDraftContact | null {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    vendor: c.vendor,
    external_customer_id: c.external_customer_id,
    date_created: c.date_created,
  };
}

/** Back into the row shape the picker takes. */
export function fromDraftContact(c: TicketDraftContact | null | undefined): ContactRow | null {
  if (!c?.id) return null;
  return { ...c, metadata: null };
}
