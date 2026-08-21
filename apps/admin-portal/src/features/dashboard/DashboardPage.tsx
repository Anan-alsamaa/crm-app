import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Toolbar } from '@yiji/ui';
import { useAuth } from '../../lib/auth/AuthContext.js';
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
  const { user } = useAuth();
  const firstName = user?.first_name || user?.email?.split('@')[0] || '';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('dashboard.title', { defaultValue: 'Overview' })}
        </h1>
      </Toolbar>

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {/* The reference dashboard's hero band: a saturated violet→jade sweep
            with the greeting and the two jumps an admin makes first. White ink
            on purpose — the fill is saturated in BOTH themes, and the theme
            tokens would flip to unreadable here. */}
        <div className="relative mb-5 overflow-hidden rounded-2xl bg-gradient-to-r from-primary via-violet to-sky p-6 shadow-float">
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(ellipse_60%_120%_at_85%_-20%,rgb(255_255_255/0.25),transparent_60%)]"
          />
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-display text-2xl font-bold tracking-tight text-white">
                {firstName
                  ? t('dashboard.heroWelcome', {
                      defaultValue: 'Welcome back, {{name}}',
                      name: firstName,
                    })
                  : t('dashboard.heroWelcomeBare', { defaultValue: 'Welcome back' })}
              </h2>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-white/85">
                {t('dashboard.heroSub', {
                  defaultValue:
                    'Here is where every complaint stands right now — filter the range below, or jump straight in.',
                })}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                to="/report-tickets"
                className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-[oklch(0.3_0.1_285)] shadow-sm transition-transform duration-fast motion-safe:hover:-translate-y-0.5"
              >
                {t('dashboard.heroTickets', { defaultValue: 'Tickets report' })}
              </Link>
              <Link
                to="/agent-performance"
                className="rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white ring-1 ring-inset ring-white/40 transition-colors duration-fast hover:bg-white/25"
              >
                {t('dashboard.heroAgents', { defaultValue: 'Agent performance' })}
              </Link>
            </div>
          </div>
        </div>

        <ComplaintDashboard />
      </div>
    </div>
  );
}
