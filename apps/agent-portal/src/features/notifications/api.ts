import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, updateItem, readMe, updateMe } from '@directus/sdk';
import { NotificationType, NotificationChannel } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  date_created: string | null;
}

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      directus.request(
        readItems('notifications', {
          limit: 30,
          fields: ['id', 'type', 'title', 'body', 'link', 'read_at', 'date_created'],
          sort: ['-date_created'],
        }),
      ) as Promise<NotificationRow[]>,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      directus.request(
        updateItem('notifications', id, { read_at: new Date().toISOString() } as never),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: ['notification-prefs'],
    queryFn: async () => {
      const me = (await directus.request(readMe({ fields: ['notification_preferences'] }))) as {
        notification_preferences?: Record<string, string> | null;
      };
      const prefs = me.notification_preferences ?? {};
      // Ensure every notification type has a default.
      const filled: Record<string, string> = {};
      for (const t of NotificationType.options) filled[t] = prefs[t] ?? 'both';
      return filled;
    },
  });
}

export function useUpdateNotificationPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prefs: Record<string, string>) =>
      directus.request(updateMe({ notification_preferences: prefs } as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-prefs'] }),
  });
}

export const NOTIFICATION_TYPES = NotificationType.options;
export const CHANNELS = NotificationChannel.options;
