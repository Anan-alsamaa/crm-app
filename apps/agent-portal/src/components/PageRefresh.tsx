import type { JSX } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshButton } from '@yiji/ui';

/**
 * Re-fetch what the page is showing, without throwing the page away.
 *
 * This used to be `location.reload()`, on the reasoning that the button is
 * reached for when a page is WEDGED and only a real reload fixes a bad route
 * or a stale bundle. True, but it is not what the button is used for: the
 * ordinary case is "someone just changed something, show me the new numbers",
 * and answering that by rebuilding the whole document throws away the
 * masthead, the route, every open drawer and the scroll position — a second
 * of white screen to deliver data the page could have fetched in place.
 *
 * Invalidating the query cache re-runs exactly the reads the current screen
 * has mounted, and nothing else. The masthead stays put, the button spins
 * until the refetches settle, and a report of 1,500 rows comes back updated
 * without the page appearing to restart.
 *
 * A page that is genuinely stuck is still F5's job, which every user already
 * knows and which no button can do better.
 */
export function PageRefresh(): JSX.Element {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return (
    <RefreshButton
      label={t('actions.refresh', { ns: 'common', defaultValue: 'Refresh' })}
      busyLabel={t('actions.refreshing', { ns: 'common', defaultValue: 'Refreshing' })}
      onRefresh={async () => {
        /*
         * `refetchType: 'active'` is the whole point: mounted queries are what
         * the reader can see, and refetching the inactive ones too would spend
         * the wait on data for pages they are not looking at.
         *
         * Awaited, so the button stays busy until the new data has actually
         * landed. Resolving early would flash "done" over stale numbers.
         */
        await qc.invalidateQueries({ refetchType: 'active' });
      }}
    />
  );
}
