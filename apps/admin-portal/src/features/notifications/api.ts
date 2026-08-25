import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, updateItem } from '@directus/sdk';
import { directus } from '../../lib/directus.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  date_created: string | null;
}

/**
 * This admin's notifications.
 *
 * FILTERED BY RECIPIENT, explicitly. An admin's Directus policy grants a broad
 * read on `notifications` — checked against the live database, `a.dawoud` could
 * read all 99 rows and not one was addressed to them. Without this filter the
 * bell would show every agent's assignments, the unread badge would be a count
 * of other people's work, and the coupon alert this was built for would be
 * buried in it. The permission cannot be the filter here, because the
 * permission is deliberately wider than the inbox.
 *
 * Disabled until the user id is known, rather than fetching unfiltered and
 * narrowing afterwards — the unfiltered response is exactly the wrong data and
 * would flash into the badge before the correct one replaced it.
 *
 * Polled rather than pushed. The agent portal has a socket connection and the
 * bell there listens on it; the admin portal has none, and opening one for a
 * bell would be a large piece of machinery for a badge. Thirty seconds is well
 * inside the window that matters for the thing this exists to carry — a coupon
 * waiting on an approval someone has to give by hand.
 */
export function useNotifications() {
  const { user } = useAuth();
  const recipient = user?.id ?? null;
  return useQuery({
    queryKey: ['notifications', recipient],
    enabled: Boolean(recipient),
    queryFn: () =>
      directus.request(
        /* `notifications` is not in this portal's generated schema, so the
           collection name is cast — which collapses the query object's own
           types to `never` and takes `sort` with it. Casting the options too
           is what keeps that from being a type error rather than a real one. */
        readItems(
          'notifications' as never,
          {
            limit: 30,
            filter: { recipient: { _eq: recipient } },
            fields: ['id', 'type', 'title', 'body', 'link', 'read_at', 'date_created'],
            sort: ['-date_created'],
          } as never,
        ) as never,
      ) as Promise<NotificationRow[]>,
    refetchInterval: 30_000,
    // Otherwise an admin who leaves the tab open all day sees a stale badge the
    // moment they come back to it.
    refetchOnWindowFocus: true,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      directus.request(
        updateItem('notifications' as never, id, { read_at: new Date().toISOString() } as never),
      ),
    /* Prefix match: the read key carries the recipient id, and react-query
       matches key prefixes, so this still invalidates it. */
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
