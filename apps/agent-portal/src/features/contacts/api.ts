import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, readItem, createItem, updateItem, deleteItem } from '@directus/sdk';
import { directus } from '../../lib/directus.js';
import { normalizePhone } from '@yiji/shared-types';

/** A tag attached to a contact via the contacts_tags junction. */
export interface ContactTagLink {
  id: string;
  tags_id: { id: string; name: string; color: string | null } | null;
}

/**
 * Contacts API.
 *
 * Reads the Directus contacts collection plus the per-contact conversation
 * and ticket lists so the profile timeline can merge them chronologically.
 * Vendor information is loaded inline so the commerce panel can fetch
 * Yiji data using the right vendor scope.
 */

export interface ContactRow {
  id: string;
  external_customer_id: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  metadata: Record<string, unknown> | null;
  vendor: { id: string; name: string; yiji_vendor_id: string } | null;
  tags?: ContactTagLink[];
  date_created: string | null;
}

export interface ContactTimelineConversation {
  id: string;
  status: string;
  priority: string;
  last_message_at: string | null;
  date_created: string | null;
}

export interface ContactTimelineTicket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  date_created: string | null;
}

export interface ContactTimelineEvent {
  id: string;
  event_type: string;
  date_created: string | null;
}

export function useContacts() {
  return useQuery({
    queryKey: ['contacts'],
    queryFn: () =>
      directus.request(
        readItems('contacts', {
          fields: [
            'id',
            'external_customer_id',
            'name',
            'phone',
            'email',
            'metadata',
            'date_created',
            'vendor.id',
            'vendor.name',
            'vendor.yiji_vendor_id',
          ],
          sort: ['-date_created'],
          limit: -1,
        }),
      ) as Promise<ContactRow[]>,
  });
}

/**
 * Server-side contact search for pickers (e.g. the New ticket dialog). Unlike
 * {@link useContacts} — which loads the whole directory — this filters in
 * Directus by phone / name / email and caps the result, so it stays fast even
 * with thousands of contacts. Phone is the primary key here: many customers
 * have no name, so the picker is search-driven and starts empty.
 *
 * Disabled until the term has at least 2 characters, so a contact must be
 * looked up (typically by phone number) rather than scrolled from a full list.
 */
export function useContactSearch(term: string) {
  const q = term.trim();
  return useQuery({
    queryKey: ['contacts-search', q],
    enabled: q.length >= 2,
    queryFn: () =>
      directus.request(
        readItems('contacts', {
          fields: [
            'id',
            'external_customer_id',
            'name',
            'phone',
            'email',
            'metadata',
            'date_created',
            'vendor.id',
            'vendor.name',
            'vendor.yiji_vendor_id',
          ],
          filter: {
            _or: [
              { phone: { _icontains: q } },
              { name: { _icontains: q } },
              { email: { _icontains: q } },
            ],
          },
          sort: ['-date_created'],
          limit: 25,
        }),
      ) as Promise<ContactRow[]>,
  });
}

export function useContact(id: string) {
  return useQuery({
    queryKey: ['contact', id],
    enabled: !!id,
    queryFn: () =>
      directus.request(
        readItem('contacts', id, {
          fields: [
            'id',
            'external_customer_id',
            'name',
            'phone',
            'email',
            'metadata',
            'date_created',
            'vendor.id',
            'vendor.name',
            'vendor.yiji_vendor_id',
            'tags.id',
            'tags.tags_id.id',
            'tags.tags_id.name',
            'tags.tags_id.color',
          ],
        }),
      ) as Promise<ContactRow>,
  });
}

/** Attach an existing tag to a contact (contacts_tags junction). */
export function useAddTagToContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ contactId, tagId }: { contactId: string; tagId: string }) =>
      directus.request(
        createItem('contacts_tags', { contacts_id: contactId, tags_id: tagId } as never),
      ),
    onSuccess: (_d, vars) => void qc.invalidateQueries({ queryKey: ['contact', vars.contactId] }),
  });
}

/** Remove a tag from a contact by its junction-row id. */
export function useRemoveTagFromContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ junctionId }: { junctionId: string; contactId: string }) =>
      directus.request(deleteItem('contacts_tags', junctionId)),
    onSuccess: (_d, vars) => void qc.invalidateQueries({ queryKey: ['contact', vars.contactId] }),
  });
}

export function useContactConversations(contactId: string) {
  return useQuery({
    queryKey: ['contact-conversations', contactId],
    enabled: !!contactId,
    queryFn: () =>
      directus.request(
        readItems('conversations', {
          filter: { contact: { _eq: contactId } },
          fields: ['id', 'status', 'priority', 'last_message_at', 'date_created'],
          sort: ['-last_message_at'],
          limit: -1,
        }),
      ) as Promise<ContactTimelineConversation[]>,
  });
}

export function useContactTickets(contactId: string) {
  return useQuery({
    queryKey: ['contact-tickets', contactId],
    enabled: !!contactId,
    queryFn: () =>
      directus.request(
        readItems('tickets', {
          filter: { contact: { _eq: contactId } },
          fields: ['id', 'subject', 'status', 'priority', 'date_created'],
          sort: ['-date_created'],
          limit: -1,
        }),
      ) as Promise<ContactTimelineTicket[]>,
  });
}

/**
 * Update a contact's core details (name / email / phone). Persists to the
 * Directus `contacts` collection — the single source of truth — so the change
 * shows everywhere the contact is read: the inbox list, the conversation
 * sidebar, the contacts page, and linked tickets. Requires the Agent role's
 * `contacts: update` permission (granted in the role matrix).
 */
export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { name?: string | null; email?: string | null; phone?: string | null };
    }) =>
      directus.request(
        updateItem(
          'contacts',
          id,
          /*
           * ONE STORED SHAPE: 05XXXXXXXX.
           *
           * A typed phone went to the database exactly as typed, so an agent
           * writing "+966 53 730 1009" created a second spelling of a customer
           * the gateway stores as "0537301009" — and every lookup that matches
           * on equality (upsertContact, the walk-in join, contact dedupe) then
           * misses. Normalised on the way IN so the column has one shape; the
           * conversions OUT (wa.me, the Yiji coupon push) stay where they are.
           */
          (patch.phone === undefined
            ? patch
            : {
                ...patch,
                phone: patch.phone ? normalizePhone(patch.phone) || null : null,
              }) as never,
        ),
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['contact', vars.id] });
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      // The contact is embedded in conversations (sidebar + inbox list) and in
      // contact timelines — refresh those so the edited name/email/phone shows
      // immediately, not just on the contacts page.
      void qc.invalidateQueries({ queryKey: ['conversation'] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['contact-conversations'] });
    },
  });
}

/**
 * Create a customer the CRM has never seen, from a phone number an agent was
 * given — a complaint phoned in, or made at a counter.
 *
 * DELIBERATELY THE SAME ROW THE GATEWAY WRITES. A walk-in who scans a branch
 * QR code already becomes a contact (`GatewayDirectus.upsertContact`), so this
 * is not a new kind of record — only a different hand typing the number. It
 * matches that shape on purpose:
 *
 *   - `external_customer_id: null` — unknown, and honestly so. Yiji's API is
 *     keyed by customer id and order id with NO lookup by phone, so a number
 *     alone cannot be resolved to an account. Writing anything invented here
 *     would be sent to Yiji as `userId` by the coupon push.
 *   - `acquisition_channel: 'phone'` — the one door a customer does not walk
 *     through themselves. Folding it into `walk_in` would inflate the QR
 *     numbers with people who never scanned anything.
 *   - `name: null` — nobody has told us their name yet. A placeholder would
 *     be worse than blank: every reader falls back to the phone number, which
 *     is true, where "Unknown" pretends to be a name.
 *
 * The phone is normalised on the way in for the same reason as
 * {@link useUpdateContact}: one stored shape, `05XXXXXXXX`, or the equality
 * lookups that find this person again will miss them.
 */
export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ phone, vendor }: { phone: string; vendor: string }) => {
      const normalized = normalizePhone(phone) || phone.trim();
      const created = (await directus.request(
        createItem('contacts', {
          vendor,
          phone: normalized,
          name: null,
          email: null,
          external_customer_id: null,
          acquisition_channel: 'phone',
        } as never),
      )) as ContactRow;
      return created;
    },
    onSuccess: () => {
      // The directory and every picker that searches it.
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      void qc.invalidateQueries({ queryKey: ['contacts-search'] });
    },
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('contacts', id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
}
