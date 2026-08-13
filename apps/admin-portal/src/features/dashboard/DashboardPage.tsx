import { useTranslation } from 'react-i18next';
import { Toolbar } from '@yiji/ui';
import { ComplaintDashboard } from './ComplaintDashboard.js';

/**
 * The Overview: what customers complained about.
 *
 * It used to be two dashboards behind a tab strip — complaints, and a "support
 * activity" view of conversation volume, SLA, CSAT and ticket lifecycle. The
 * second is gone by request. It answered "how are WE working", which the
 * Reports section already answers in more detail and with filters an admin can
 * act on; keeping a shallower copy of it here meant the first thing anyone saw
 * on opening the console was a tab decision rather than an answer.
 *
 * The name stays "Overview" rather than becoming "Complaints": it is the
 * console's landing page, and people navigate to it by position and habit.
 *
 * The complaints view carries its own from/to/brand/city/store filter bar, so
 * there is deliberately no range picker in this toolbar to disagree with it.
 */
export function DashboardPage() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('dashboard.title', { defaultValue: 'Overview' })}
        </h1>
      </Toolbar>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <ComplaintDashboard />
      </div>
    </div>
  );
}
