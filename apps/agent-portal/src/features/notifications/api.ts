import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, updateItem, createItem, readMe, updateMe } from '@directus/sdk';
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

/**
 * The organisation-wide notification defaults, set by an administrator.
 *
 * Stored in `app_settings` under one key rather than copied onto every user,
 * so changing it takes effect for everybody at once and nobody's own choices
 * are rewritten to hold it. Agents can read `app_settings`, which is what lets
 * this resolve in their own portal.
 *
 * An empty object — the ordinary state before anybody sets anything — means
 * "no organisation policy", and every type falls back to `both`.
 */
export const ORG_PREFS_KEY = 'notification_defaults';

export function useOrgNotificationDefaults() {
  return useQuery({
    queryKey: ['app-setting', ORG_PREFS_KEY],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Record<string, string>> => {
      try {
        const rows = (await directus.request(
          readItems(
            'app_settings' as never,
            {
              filter: { key: { _eq: ORG_PREFS_KEY } },
              limit: 1,
              fields: ['value'],
            } as never,
          ),
        )) as unknown as Array<{ value: string | null }>;
        const raw = rows[0]?.value?.trim();
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
      } catch {
        /* A missing row, a malformed value, or no permission — all mean "no
           policy". This must never break the page an agent uses to control
           their own notifications. */
        return {};
      }
    },
  });
}

/**
 * Write the organisation defaults. Administrators only — the Directus
 * permission is the real gate; the UI simply does not offer the control to
 * anybody else.
 */
export function useUpdateOrgNotificationDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (prefs: Record<string, string>) => {
      const value = JSON.stringify(prefs);
      const rows = (await directus.request(
        readItems(
          'app_settings' as never,
          { filter: { key: { _eq: ORG_PREFS_KEY } }, limit: 1, fields: ['id'] } as never,
        ),
      )) as unknown as Array<{ id: string }>;
      if (rows[0]) {
        await directus.request(
          updateItem(
            'app_settings' as never,
            rows[0].id as never,
            {
              value,
            } as never,
          ),
        );
        return;
      }
      await directus.request(
        createItem('app_settings' as never, { key: ORG_PREFS_KEY, value } as never),
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['app-setting', ORG_PREFS_KEY] });
      void qc.invalidateQueries({ queryKey: ['notification-prefs'] });
    },
  });
}

/**
 * THE PRECEDENCE RULE: the administrator's setting wins (owner, 2026-09-16).
 *
 * Both an administrator and an agent can set a preference, and where they
 * disagree the organisation's answer is the one that applies. An agent's own
 * choice is NOT deleted — it is stored, it is what they see on their own page,
 * and it governs again the moment the administrator stops dictating that type.
 * Overwriting their row instead would make the change irreversible and would
 * silently discard a choice somebody made deliberately.
 *
 * So the policy is applied per TYPE, not wholesale: an administrator who dictates
 * SLA breaches leaves every other notification to the agent.
 */
export function resolvePreferences(
  mine: Record<string, string> | null | undefined,
  org: Record<string, string> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of NotificationType.options) {
    out[t] = org?.[t] ?? mine?.[t] ?? 'both';
  }
  return out;
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
