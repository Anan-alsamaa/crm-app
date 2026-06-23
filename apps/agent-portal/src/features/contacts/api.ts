import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, readItem, createItem, updateItem, deleteItem } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

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
    }) => directus.request(updateItem('contacts', id, patch as never)),
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

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('contacts', id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
}
