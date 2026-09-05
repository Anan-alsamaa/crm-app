import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { cn, Toolbar } from '@yiji/ui';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { ComplaintDashboard } from './ComplaintDashboard.js';

/**
 * Two dashboards, because there are two jobs.
 *
 * **Operations** is about BRANCHES: which of them customers are complaining
 * about, for what, and how that moves over the months. **Agent** is about the
 * support desk: how many chats and tickets are in hand, how many people are
 * waiting, what customers thought, and what compensation has cost.
 *
 * They used to be one page of fourteen panels, and the support half was
 * scattered through the branch half — so the question "how many people are
 * waiting right now" could not be answered without reading past a brand
 * breakdown. Splitting them means each page is short enough to take in.
 *
 * The Agent tab needs `view_all_chats`. That is what makes "operations can see
 * the operations dashboard" true rather than aspirational: an Operations role
 * holds `view_dashboard` and not `view_all_chats`, so it lands here and finds
 * one dashboard, with no strip suggesting there is somewhere else to be.
 */

type Tab = 'operations' | 'agent';

export function DashboardPage() {
  const { t } = useTranslation();
  const { user, can, isOwner } = useAuth();
  const firstName = user?.first_name || user?.email?.split('@')[0] || '';
  const canSeeAgent = can('view_all_chats');
  // The operations board is its own privilege now: the desk is not shown the
  // branch/brand/area-manager cuts unless told, and operations is not shown
  // the desk. The owner sees both.
  const canSeeOps = isOwner || can('view_ops_dashboard');
  const [tab, setTab] = useState<Tab>('agent');
  const active: Tab = canSeeAgent && canSeeOps ? tab : canSeeAgent ? 'agent' : 'operations';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('dashboard.title', { defaultValue: 'Dashboard' })}
        </h1>
      </Toolbar>

      {/* A strip of one is a label, not a choice — a role with a single
          dashboard is simply shown it. */}
      {canSeeAgent && canSeeOps && (
        <nav
          aria-label={t('dashboard.title', { defaultValue: 'Dashboard' })}
          className="flex shrink-0 items-center gap-1 border-b border-foreground/[0.06] px-4 py-2"
        >
          {(
            [
              ['agent', t('dashboard.tabAgent', { defaultValue: 'Agent' })],
              ['operations', t('dashboard.tabOperations', { defaultValue: 'Operations' })],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-current={active === key ? 'page' : undefined}
              className={cn(
                'shrink-0 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap',
                'transition-[background-color,color,font-weight] duration-fast ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                active === key
                  ? 'bg-primary/15 font-semibold text-primary ring-1 ring-inset ring-primary/25'
                  : 'font-medium text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </nav>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4 sm:p-6">
        {active === 'agent' && (
          <>
            {/* The reference dashboard's hero band: a saturated violet→jade
                sweep with the greeting and the two jumps a supervisor makes
                first. White ink on purpose — the fill is saturated in BOTH
                themes, and the theme tokens would flip to unreadable here. */}
            <div className="relative mb-5 shrink-0 overflow-hidden rounded-2xl bg-gradient-to-r from-primary via-violet to-brand-glow p-6 shadow-float">
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
                        'Here is where every ticket stands right now — filter the range below, or jump straight in.',
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    to="/reports/operational-kpi/tickets"
                    className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-[oklch(0.3_0.1_285)] shadow-sm transition-transform duration-fast motion-safe:hover:-translate-y-0.5"
                  >
                    {t('dashboard.heroTickets', { defaultValue: 'Ticket breakdown' })}
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
          </>
        )}
        {active === 'operations' && (
          /* Operations gets a hero too, and a DIFFERENT sweep.
             Only the Agent tab had one, so switching to Operations dropped from
             a saturated band straight into pale cards and the page read as the
             emptier of the two — when it is the one an operations lead opens
             daily. Sky→violet rather than violet→jade so the two boards are
             told apart by colour before a word is read.
             White ink deliberately: the fill is saturated in BOTH themes, and
             theme tokens would flip to unreadable on it. */
          <div className="relative mb-5 shrink-0 overflow-hidden rounded-2xl bg-gradient-to-r from-sky via-primary to-violet p-6 shadow-float">
            <div
              aria-hidden
              className="absolute inset-0 bg-[radial-gradient(ellipse_60%_120%_at_85%_-20%,rgb(255_255_255/0.28),transparent_60%)]"
            />
            <div className="relative min-w-0">
              <h2 className="font-display text-2xl font-bold tracking-tight text-white">
                {t('dashboard.opsHero', { defaultValue: 'Operations' })}
              </h2>
              <p className="mt-1 max-w-prose text-sm leading-relaxed text-white/85">
                {t('dashboard.opsHeroHint', {
                  defaultValue:
                    'Which branches customers are complaining about, and which area managers own them.',
                })}
              </p>
            </div>
          </div>
        )}
        <ComplaintDashboard view={active} />
      </div>
    </div>
  );
}
