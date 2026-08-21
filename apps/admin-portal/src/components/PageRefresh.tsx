import type { JSX } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshButton } from '@yiji/ui';

/**
 * Refetch everything the current page is showing.
 *
 * `refetchType: 'active'` on purpose: only queries something is currently
 * MOUNTED against. Refetching the whole cache would also pull data for pages
 * nobody is looking at, which costs the same requests and answers nothing.
 *
 * Invalidating with no key matches every query, so this works on every page
 * without the button needing to know which page it is on.
 */
export function PageRefresh(): JSX.Element {
  const qc = useQueryClient();
  const { t } = useTranslation();
  return (
    <RefreshButton
      label={t('actions.refreshPage', { ns: 'common', defaultValue: 'Refresh this page' })}
      onRefresh={() => qc.invalidateQueries({ refetchType: 'active' })}
    />
  );
}
