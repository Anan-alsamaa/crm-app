import { useTranslation } from 'react-i18next';
import { EmptyState, Spinner } from '@yiji/ui';
import { staffDisplayName } from '@yiji/shared-types';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import { useActivity } from './api.js';

/** Who did what, newest first. Read-only: the log is append-only for every role. */
export function ActivityPage() {
  const { t, i18n } = useTranslation();
  const q = useActivity();
  const rows = q.data ?? [];
  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language === 'ar' ? 'ar-SA' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('activity.title', { defaultValue: 'Activity log' })}
        description={t('activity.desc', {
          defaultValue:
            'Every action taken in the Marketing portal, newest first. Nobody can edit or delete it.',
        })}
      />
      <div className={PAGE_BODY}>
        {q.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner size={22} />
          </div>
        ) : q.isError ? (
          <EmptyState
            title={t('activity.error', { defaultValue: 'The activity log could not be loaded' })}
            description={t('activity.errorHint', {
              defaultValue: 'Refresh the page to try again.',
            })}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('activity.empty', { defaultValue: 'No activity yet' })}
            description={t('activity.emptyHint', {
              defaultValue: 'Coupons, bulk sends and approvals will be listed here as they happen.',
            })}
          />
        ) : (
          <div className={SECTION_CARD}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="px-4 py-3 text-start font-medium">
                    {t('activity.when', { defaultValue: 'When' })}
                  </th>
                  <th className="px-4 py-3 text-start font-medium">
                    {t('activity.who', { defaultValue: 'Who' })}
                  </th>
                  <th className="px-4 py-3 text-start font-medium">
                    {t('activity.what', { defaultValue: 'What' })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-foreground/[0.06]">
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground">
                      {when(r.date_created)}
                    </td>
                    <td className="px-4 py-3">{staffDisplayName(r.user_created, '—')}</td>
                    <td className="px-4 py-3">{r.summary ?? r.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
