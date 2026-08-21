import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshButton } from '@yiji/ui';

/**
 * Reload the current page, properly.
 *
 * `location.reload()` and nothing else. The point of this control is the case
 * where the page is WEDGED — a component in a bad state, a stale bundle after
 * a deploy, a route that will not settle — and none of those survive a real
 * reload. A cache refetch, which is what this used to do, fixes none of them
 * while looking from the outside like the button did nothing.
 *
 * `reload()` re-requests the document, so an in-flight mutation is abandoned
 * exactly as it would be by F5. That is the accepted cost of the button people
 * reach for when the page is already not working.
 */
export function PageRefresh(): JSX.Element {
  const { t } = useTranslation();
  return (
    <RefreshButton
      label={t('actions.refresh', { ns: 'common', defaultValue: 'Refresh' })}
      busyLabel={t('actions.refreshing', { ns: 'common', defaultValue: 'Refreshing' })}
      onRefresh={() => {
        window.location.reload();
        // The document is being replaced; resolving would only flip the button
        // out of its busy state for the frames before it disappears.
        return new Promise<never>(() => {});
      }}
    />
  );
}
