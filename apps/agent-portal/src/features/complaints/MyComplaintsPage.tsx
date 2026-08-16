import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectMenu, Toolbar, ToolbarSpacer } from '@yiji/ui';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useMyComplaints } from './api.js';
import { ComplaintsTable } from './ComplaintsTable.js';

/**
 * The agent's own complaints, in the operations report format.
 *
 * The table and its data layer already existed — built, tested, and never
 * routed, so an agent asked for their own numbers had to go and ask an admin
 * for a report the ops portal could already produce. This is the page that was
 * missing, not the feature.
 *
 * Scoped to the signed-in agent by name, which is what `useMyComplaints`
 * filters on. An agent cannot widen it to somebody else's work.
 */
export function MyComplaintsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [days, setDays] = useState<number | null>(30);

  const agentName = useMemo(
    () =>
      [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() || (user?.email ?? ''),
    [user],
  );
  const complaints = useMyComplaints(days, agentName);

  const ranges = [
    { value: '7', label: t('performance.last7', { defaultValue: 'Last 7 days' }) },
    { value: '30', label: t('performance.last30', { defaultValue: 'Last 30 days' }) },
    { value: '90', label: t('performance.last90', { defaultValue: 'Last 90 days' }) },
    { value: 'all', label: t('complaints.allTime', { defaultValue: 'All time' }) },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('complaints.title', { defaultValue: 'My complaints' })}
        </h1>
        <ToolbarSpacer />
        <SelectMenu
          value={days === null ? 'all' : String(days)}
          onChange={(v) => setDays(v === 'all' ? null : Number(v))}
          options={ranges}
          aria-label={t('performance.range', { defaultValue: 'Range' })}
        />
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-6xl space-y-5">
          <div className="border-b border-foreground/10 pb-5">
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t('complaints.hint', {
                defaultValue:
                  'Every complaint you handled, in the same format operations reports in. Rearrange the columns, then export to Excel.',
              })}
            </p>
          </div>
          <ComplaintsTable
            rows={complaints.data ?? []}
            loading={complaints.isLoading}
            days={days}
            filenameBase={t('complaints.title', { defaultValue: 'My complaints' })}
          />
        </div>
      </div>
    </div>
  );
}
