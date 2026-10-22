import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { cn, Toolbar, ToolbarSpacer } from '@yiji/ui';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { ComplaintDashboard } from './ComplaintDashboard.js';
import { UpdateBanner } from '../releases/UpdateBanner.js';

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
  const { can, isOwner } = useAuth();
  // Each board is its own switch (owner, 2026-10-12). The Agent one defaults to
  // the old rule - open the page AND see all chats - so nobody's view changed.
  const canSeeAgent = isOwner || can('view_agent_dashboard');
  // The operations board is its own privilege now: the desk is not shown the
  // branch/brand/area-manager cuts unless told, and operations is not shown
  // the desk. The owner sees both.
  const canSeeOps = isOwner || can('view_ops_dashboard');
  const [tab, setTab] = useState<Tab>('agent');
  const active: Tab = canSeeAgent && canSeeOps ? tab : canSeeAgent ? 'agent' : 'operations';

  // The element beside the title that the stat strip is portalled into.
  const [statSlot, setStatSlot] = useState<HTMLDivElement | null>(null);

  /*
   * THE RAPPORT HEADER (owner, 2026-10-22): the big title, the stat strip
   * beside it, and on the far side the board switch as a segmented control
   * and the two jumps a supervisor makes first. It replaces the gradient hero
   * band, which said the same things in a 100px slab.
   */
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('dashboard.title', { defaultValue: 'Dashboard' })}
        </h1>
        <div
          ref={setStatSlot}
          className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-3 ps-2 empty:hidden lg:ps-6"
        />
        <ToolbarSpacer />
        {/* A strip of one is a label, not a choice — a role with a single
            dashboard is simply shown it. */}
        {canSeeAgent && canSeeOps && (
          <nav
            aria-label={t('dashboard.title', { defaultValue: 'Dashboard' })}
            className="flex shrink-0 items-center gap-0.5 rounded-full bg-foreground/[0.06] p-1"
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
                  'shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold whitespace-nowrap',
                  'transition-[background-color,color,box-shadow] duration-fast ease-out',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  active === key
                    ? 'bg-white text-foreground shadow-[0_4px_12px_-6px_oklch(var(--shadow-color)/0.45)]'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
        {active === 'agent' && (
          <div className="flex shrink-0 items-center gap-2">
            <Link
              to="/reports/operational-kpi/tickets"
              className="rounded-full bg-white/60 px-4 py-2 text-sm font-semibold text-foreground ring-1 ring-inset ring-foreground/10 transition-colors duration-fast hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {t('dashboard.heroTickets', { defaultValue: 'Ticket breakdown' })}
            </Link>
            <Link
              to="/agent-performance"
              className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-ink-foreground transition-colors duration-fast hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2"
            >
              {t('dashboard.heroAgents', { defaultValue: 'Agent performance' })}
            </Link>
          </div>
        )}
      </Toolbar>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-5 pb-6 pt-2 sm:px-7">
        {/* A published build waiting to be released. Above everything because
            it is a decision to make, not a reading to take — and it renders
            nothing at all when production is up to date, which is most of the
            time. Outside the tab branches so it shows on either board. */}
        <div className="mb-4 shrink-0 empty:mb-0">
          <UpdateBanner />
        </div>
        {active === 'operations' && (
          /* What this board is for, in one line - the operations hero's
             sentence, kept now that the hero band is gone. */
          <p className="mb-4 max-w-prose px-1 text-sm text-muted-foreground">
            {t('dashboard.opsHeroHint', {
              defaultValue:
                'Which branches customers are complaining about, and which area managers own them.',
            })}
          </p>
        )}
        <ComplaintDashboard view={active} statSlot={statSlot} />
      </div>
    </div>
  );
}
