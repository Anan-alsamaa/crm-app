import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems, updateItem } from '@directus/sdk';
import { directus } from '../../lib/directus.js';

/**
 * Which complaint types the BRANCH hears about, and the queue of what has been
 * decided so far.
 *
 * The rules are rows rather than a constant because operations change them
 * without a deploy. A type with no row has never been considered and does not
 * notify; a row with `enabled: false` is one that was considered and turned
 * off. Keeping the disabled row is deliberate — it is the record that somebody
 * made that decision, and it survives being turned back on.
 */
export interface StoreNotifyRule {
  id: string;
  complaint_type: string;
  enabled: boolean;
}

export function useStoreNotifyRules() {
  return useQuery({
    queryKey: ['store-notify-rules'],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'store_notify_rules' as never,
          {
            fields: ['id', 'complaint_type', 'enabled'],
            limit: -1,
          } as never,
        ),
      )) as unknown as StoreNotifyRule[],
  });
}

/**
 * Turn one complaint type on or off.
 *
 * Upsert, not create: toggling a type off and on again must reuse its row
 * rather than leaving two rows disagreeing about the same type.
 */
export function useSetStoreNotifyRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      complaintType,
      enabled,
      existingId,
    }: {
      complaintType: string;
      enabled: boolean;
      existingId?: string;
    }) => {
      if (existingId) {
        return directus.request(
          updateItem('store_notify_rules' as never, existingId, { enabled } as never),
        );
      }
      return directus.request(
        createItem(
          'store_notify_rules' as never,
          {
            complaint_type: complaintType,
            enabled,
          } as never,
        ),
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['store-notify-rules'] });
    },
  });
}

export interface StoreNotificationRow {
  id: string;
  complaint_type: string | null;
  description: string | null;
  resolution_notes: string | null;
  order_id: string | null;
  order_items: Array<{ name: string; qty: number; price?: number }> | null;
  status: 'queued' | 'sent' | 'failed';
  sent_at: string | null;
  date_created: string | null;
  ticket: { id: string; subject: string | null } | null;
  store: { id: string; code: string | null; name: string | null } | null;
}

/** The outbox, newest first. Read-only here: nothing rewrites what was sent. */
export function useStoreNotifications(limit = 50) {
  return useQuery({
    queryKey: ['store-notifications', limit],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'store_notifications' as never,
          {
            fields: [
              'id',
              'complaint_type',
              'description',
              'resolution_notes',
              'status',
              'sent_at',
              'date_created',
              { ticket: ['id', 'subject'] },
              { store: ['id', 'code', 'name'] },
            ],
            sort: ['-date_created'],
            limit,
          } as never,
        ),
      )) as unknown as StoreNotificationRow[],
  });
}
