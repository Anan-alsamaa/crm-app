import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AppShell, MetricMotionProvider, useIsDesktop, type AppShellRailContext } from '@yiji/ui';

/*
 * THE AGENT SHELL (owner, 2026-10-22: the admin console's Rapport look, on the
 * agent portal too).
 *
 * Desktop: no masthead slab. The brand sits on the page at the start, the
 * destinations are CENTRED as pill tabs on a dark nav bar, and the round
 * utility buttons (Busy, refresh, notifications, AI help, sound, language)
 * and the account sit at the end. No side rail.
 *
 * Mobile (< lg): the shared AppShell, unchanged - it already does the drawer,
 * the focus and scroll locking and the Escape handling.
 *
 * Owned by this portal, a sibling of the admin console's AdminShell rather
 * than a shared extraction: the admin console must stay exactly as it is, and
 * the two shells are free to drift where their users differ (the agent's bar
 * carries Busy and the sound switch; the admin's does not).
 */

export interface AgentShellProps {
  /** The centred pill navigation. */
  nav: ReactNode;
  /** The round utility buttons and account chip at the end of the header. */
  utilities: ReactNode;
  /** The vertical nav for the mobile drawer. */
  mobileRail: (ctx: AppShellRailContext) => ReactNode;
  mobileBrand: ReactNode;
  mobileActions: ReactNode;
  navLabel: string;
  menuLabel: string;
  closeLabel: string;
  /**
   * Count the headline numerals up when they change. Off in the inbox: its
   * counters change on every poll and on every chat switch, and an agent sees
   * that hundreds of times a day.
   */
  animateMetrics: boolean;
  children: ReactNode;
}

export function AgentShell({
  nav,
  utilities,
  mobileRail,
  mobileBrand,
  mobileActions,
  navLabel,
  menuLabel,
  closeLabel,
  animateMetrics,
  children,
}: AgentShellProps) {
  const isDesktop = useIsDesktop();
  const { t } = useTranslation();
  const motion = useMemo(
    () => ({ animate: animateMetrics, emptyHint: String(t('shell.metricEmpty')) }),
    // `t` changes identity when the language does.
    [animateMetrics, t],
  );
  /* The shared empty-table notice is drawn by the stylesheet; its strings
     reach it as custom properties, so they follow the language. */
  const skinVars = useMemo(
    () =>
      ({
        '--agent-empty-title': JSON.stringify(String(t('shell.tableEmptyTitle'))),
        '--agent-empty-hint': JSON.stringify(String(t('shell.tableEmptyHint'))),
      }) as CSSProperties,
    [t],
  );

  if (!isDesktop) {
    return (
      <MetricMotionProvider value={motion}>
        <div className="agent-skin h-full" style={skinVars}>
          <AppShell
            rail={mobileRail}
            topBarBrand={mobileBrand}
            topBarActions={mobileActions}
            resizeStorageKey="yiji.agent.sidebarWidth"
            navLabel={navLabel}
            menuLabel={menuLabel}
            closeLabel={closeLabel}
          >
            {children}
          </AppShell>
        </div>
      </MetricMotionProvider>
    );
  }

  return (
    <MetricMotionProvider value={motion}>
      <div className="agent-skin flex h-full flex-col text-foreground" style={skinVars}>
        <header
          /* The environment badge finds this bar by name and renders INSIDE it
             (see EnvironmentBanner), in the slot stacked over the nav. */
          data-app-topbar=""
          className="agent-gutter sticky top-0 z-30 flex h-[4.5rem] shrink-0 items-center gap-4"
        >
          <div className="flex shrink-0 items-center gap-3">
            {/* The artwork's corners are already cut; no rounding on the img. */}
            <img src="/sara-crm-icon.svg" alt="Sara CRM" className="h-11 w-11 shrink-0" />
            <span
              aria-hidden
              className="hidden text-[1.3125rem] font-bold tracking-[-0.02em] text-foreground 2xl:inline"
            >
              Sara CRM
            </span>
          </div>
          {/* `minmax(0,1fr)` so the column may shrink below the pills' natural
              width; the environment badge sits ABOVE the nav in the same cell,
              so it never shunts the pills sideways. */}
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] place-items-center">
            <nav
              aria-label={navLabel}
              className="col-start-1 row-start-1 flex min-w-0 max-w-full items-center justify-center rounded-full bg-gradient-to-b from-ink to-rail-deep p-1.5 shadow-[0_24px_48px_-24px_oklch(var(--shadow-color)/0.6)]"
            >
              {nav}
            </nav>
            <div
              data-env-slot=""
              className="col-start-1 row-start-1 -translate-y-[28px] empty:hidden"
            />
          </div>
          <div className="agent-utilities flex shrink-0 items-center gap-1.5">{utilities}</div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
        </div>
      </div>
    </MetricMotionProvider>
  );
}
