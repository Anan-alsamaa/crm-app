import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, readItem, deleteItem } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

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
          ],
        }),
      ) as Promise<ContactRow>,
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

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => directus.request(deleteItem('contacts', id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
}
