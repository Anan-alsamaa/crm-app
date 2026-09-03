import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import { staffDisplayName } from '@yiji/shared-types';
import { useTranslation } from 'react-i18next';
import {
  AppShell,
  Avatar,
  CalendarIcon,
  ChartIcon,
  ClockIcon,
  DownloadIcon,
  ErrorBoundary,
  NewVersionBanner,
  SettingsIcon,
  ShieldIcon,
  SignOutIcon,
  SparkleIcon,
  Spinner,
  StoreIcon,
  TeamIcon,
  Toaster,
  UsersIcon,
  cn,
  type AppShellRailContext,
} from '@yiji/ui';
import { RouteError } from './components/RouteError.js';
import { TopNav } from './components/TopNav.js';
import { AuthProvider, useAuth } from './lib/auth/AuthContext.js';
import { ProtectedRoute } from './lib/auth/ProtectedRoute.js';
import { Login } from './pages/Login.js';
import { ResetPassword, RESET_PASSWORD_PATH } from './pages/ResetPassword.js';
import { LanguageToggle } from './components/LanguageToggle.js';
import { NotificationBell } from './features/notifications/NotificationBell.js';
import { PageRefresh } from './components/PageRefresh.js';
import { HelpAssistant } from './features/help-assistant/HelpAssistant.js';
import { AppCommandPalette } from './components/AppCommandPalette.js';
import { AppKeyboardShortcuts } from './components/AppKeyboardShortcuts.js';

// Route pages are code-split so the initial bundle stays lean.
const DashboardPage = lazy(() =>
  import('./features/dashboard/DashboardPage.js').then((m) => ({ default: m.DashboardPage })),
);
const UsersPage = lazy(() =>
  import('./features/users/UsersPage.js').then((m) => ({ default: m.UsersPage })),
);
const TeamsPage = lazy(() =>
  import('./features/teams/TeamsPage.js').then((m) => ({ default: m.TeamsPage })),
);
const SlaPoliciesPage = lazy(() =>
  import('./features/sla/SlaPoliciesPage.js').then((m) => ({ default: m.SlaPoliciesPage })),
);
const VendorsPage = lazy(() =>
  import('./features/vendors/VendorsPage.js').then((m) => ({ default: m.VendorsPage })),
);
const BrandsPage = lazy(() =>
  import('./features/restaurants/BrandsPage.js').then((m) => ({ default: m.BrandsPage })),
);
const StoresPage = lazy(() =>
  import('./features/restaurants/StoresPage.js').then((m) => ({ default: m.StoresPage })),
);
const ReportsPage = lazy(() =>
  import('./features/reports/ReportsPage.js').then((m) => ({ default: m.ReportsPage })),
);
const AllCompensationPage = lazy(() =>
  import('./features/coupon-approvals/AllCompensationPage.js').then((m) => ({
    default: m.AllCompensationPage,
  })),
);
const CouponReportPage = lazy(() =>
  import('./features/coupon-approvals/CouponReportPage.js').then((m) => ({
    default: m.CouponReportPage,
  })),
);
const CouponApprovalsPage = lazy(() =>
  import('./features/coupon-approvals/CouponApprovalsPage.js').then((m) => ({
    default: m.CouponApprovalsPage,
  })),
);
const StoreNotificationsPage = lazy(() =>
  import('./features/store-notifications/StoreNotificationsPage.js').then((m) => ({
    default: m.StoreNotificationsPage,
  })),
);
const AgentPerformancePage = lazy(() =>
  import('./features/performance/AgentPerformancePage.js').then((m) => ({
    default: m.AgentPerformancePage,
  })),
);
const ReportExportsPage = lazy(() =>
  import('./features/report-exports/AgentReportsPage.js').then((m) => ({
    default: m.AgentReportsPage,
  })),
);
const SlaReportsPage = lazy(() =>
  import('./features/sla-reports/SlaReportsPage.js').then((m) => ({ default: m.SlaReportsPage })),
);
const OptionListsPage = lazy(() =>
  import('./features/lists/OptionListsPage.js').then((m) => ({ default: m.OptionListsPage })),
);
const RolesPage = lazy(() =>
  import('./features/app-roles/RolesPage.js').then((m) => ({ default: m.RolesPage })),
);
const BackupPage = lazy(() =>
  import('./features/backup/BackupPage.js').then((m) => ({ default: m.BackupPage })),
);
const AiConfigPage = lazy(() =>
  import('./features/ai-config/AiConfigPage.js').then((m) => ({ default: m.AiConfigPage })),
);

import type { TFunction } from 'i18next';
import type { NavSection } from './nav.js';
import type { Privilege } from './lib/privileges.js';
import { ReportGroupTabs } from './components/ReportGroupTabs.js';

/* Colorful nav: each item's icon sits in its own vivid tinted tile that pops
 * against the dark navy rail. */
const NAV_TILES = [
  'bg-sky/25 text-sky',
  'bg-violet/25 text-violet',
  'bg-rose-400/25 text-rose-300',
  'bg-orange-400/25 text-orange-300',
  'bg-emerald-400/25 text-emerald-300',
];

function Rail({ ctx, sections }: { ctx: AppShellRailContext; sections: NavSection[] }) {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const name = staffDisplayName(user, '');
  const isCollapsed = ctx.collapsed;

  return (
    <>
      {/* Brand */}
      <div
        className={cn(
          'flex h-14 items-center gap-2.5 shrink-0 border-b border-white/[0.06]',
          isCollapsed ? 'justify-center px-2' : 'px-3.5',
        )}
      >
        {/* The tile NAMES the product, so nothing beside it repeats it. What
            stays is which portal you are in, which the logo cannot tell you. */}
        {isCollapsed ? (
          <img src="/sara-crm-icon.png" alt="Sara CRM" className="h-8 w-8 shrink-0 rounded-lg" />
        ) : (
          <div className="flex min-w-0 items-center gap-2.5 leading-tight">
            <img src="/sara-crm-icon.png" alt="Sara CRM" className="h-9 w-9 shrink-0 rounded-lg" />
            <div className="min-w-0 truncate text-2xs text-rail-foreground/75">
              {t('app.console', { defaultValue: 'Admin console' })}
            </div>
          </div>
        )}
      </div>

      <div
        className={cn(
          'flex-1 overflow-y-auto overflow-x-hidden py-3 space-y-4',
          isCollapsed ? 'px-2' : 'px-2.5',
        )}
      >
        {sections.map((sec, sIdx) => (
          <div key={sIdx}>
            {sec.heading && !isCollapsed && (
              <h3 className="mb-1 px-2 text-2xs font-semibold uppercase tracking-[0.12em] text-rail-foreground/70 whitespace-nowrap">
                {sec.heading}
              </h3>
            )}
            <ul className="space-y-0.5">
              {sec.items.map((it, iIdx) => (
                <li key={it.to}>
                  <NavLink
                    to={it.to}
                    title={it.label}
                    onClick={ctx.onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex h-9 items-center rounded-lg text-sm',
                        'transition-[background-color,color,box-shadow] duration-fast ease-out',
                        'hover:bg-rail-active hover:text-rail-active-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                        isActive
                          ? 'bg-rail-active font-semibold text-rail-active-foreground shadow-sm shadow-black/10'
                          : 'font-medium text-rail-foreground/85',
                        isCollapsed ? 'justify-center px-0' : 'gap-2.5 px-2',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          className={cn(
                            'grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors duration-fast ease-out',
                            isActive
                              ? 'bg-primary text-primary-foreground'
                              : NAV_TILES[(sIdx * 2 + iIdx) % NAV_TILES.length],
                          )}
                        >
                          <it.icon size={14} />
                        </span>
                        {!isCollapsed && <span className="flex-1 truncate">{it.label}</span>}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div
        className={cn(
          'shrink-0 border-t border-white/[0.06] py-2',
          isCollapsed ? 'px-2 space-y-1.5' : 'px-2.5 space-y-1',
        )}
      >
        {!isCollapsed && <LanguageToggle />}
        <div
          className={cn(
            'flex items-center rounded-md',
            isCollapsed ? 'justify-center py-1' : 'gap-2.5 px-1 py-1',
          )}
        >
          <Avatar name={name} email={user?.email} size="sm" />
          {!isCollapsed && (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-rail-active-foreground leading-tight">
                  {name || 'Admin'}
                </div>
                <div className="truncate text-2xs text-rail-foreground/70 leading-tight">
                  {user?.email ?? ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void logout()}
                aria-label={t('auth.signOut', { ns: 'common' })}
                title={t('auth.signOut', { ns: 'common' })}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-rail-foreground/70 transition-[background-color,color,transform] duration-fast ease-out hover:bg-rail-active hover:text-rail-active-foreground active:scale-[0.94]"
              >
                <SignOutIcon size={14} />
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** The masthead brand: the logo tile, and nothing else. */
function MobileBrand() {
  return (
    /*
     * THE TILE ALONE, centred in the bar.
     *
     * There was a caption under it ("Admin console" / "User workspace") and it
     * was the thing that made this corner look unfinished: at 71px it was
     * WIDER than the 56px tile, so the block had a ragged right edge, and the
     * two together stood 69px tall in an 80px bar with nothing to breathe.
     *
     * It was also redundant. The masthead already names the portal on the
     * other side — the account chip reads "Admin" — and the browser tab says
     * "Sara CRM · Admin". Three statements of the same fact, and the worst-
     * looking one was load-bearing for nothing.
     *
     * Removing it settles the size question too. The caption was what defined
     * the block's width, so the tile can now be as large as the bar allows —
     * 64px in an 80px header, leaving an even 8px above and below — and the
     * block is still NARROWER than it was, which gives the nav back a few
     * pixels rather than taking any.
     */
    <img
      src="/sara-crm-icon.png"
      alt="Sara CRM"
      /* No `rounded-*`: the artwork's corners are already cut and its radius is
         transparent, so rounding the element clips them a second time. */
      className="h-16 w-16 shrink-0"
    />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const tabs = reportTabs(t);
  const location = useLocation();
  const { user, logout, can } = useAuth();
  const displayName = staffDisplayName(user, 'Admin');
  // Command-palette open state is lifted here so the top-bar search trigger and
  // the Cmd/Ctrl+K shortcut both drive the one palette instance below.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Sidebar ranked by how often an operations lead reaches for each area:
  // the daily pulse (Overview) → all the reporting under one "Reports" heading
  // (one entry per report) → managing the org (Workspace) → setup that rarely
  // changes (Policies, Intelligence). Each report is its own clearly-named
  // entry: Ticket report + SLA performance (live dashboards you view), and
  // Scheduled reports + Excel exports (the ways you get data OUT).
  const allSections: NavSection[] = [
    {
      heading: t('nav.overview', { defaultValue: 'Overview' }),
      items: [
        {
          to: '/dashboard',
          requires: 'view_dashboard' as const,
          label: t('nav.dashboard', { defaultValue: 'Dashboard' }),
          icon: ChartIcon,
        },
      ],
    },
    {
      heading: t('nav.reportsGroup', { defaultValue: 'Reports' }),
      /**
       * Three destinations, not seven.
       *
       * Each one is a PAGE that carries its own strip of report tabs beneath
       * the masthead — see ReportGroupTabs. The previous shape put all seven
       * reports in this dropdown under two headings, which meant the whole
       * menu had to be read before any of it could be dismissed, and the only
       * thing saying which half you were in was a heading inside a menu that
       * closes.
       */
      items: [
        {
          to: '/reports/agent-kpi',
          requires: 'view_all_chats' as const,
          label: t('nav.agentKpiGroup', { defaultValue: 'Agent KPI' }),
          icon: DownloadIcon,
        },
        {
          to: '/reports/operational-kpi',
          requires: 'view_all_tickets' as const,
          label: t('nav.opsKpiGroup', { defaultValue: 'Operational KPI' }),
          icon: DownloadIcon,
        },
        {
          // NOT `/reports`: that is now the parent of the two KPI pages, so a
          // link to it would light up alongside whichever one is open.
          to: '/reports/scheduled',
          requires: 'manage_lists' as const,
          label: t('nav.reports', { defaultValue: 'Scheduled reports' }),
          icon: CalendarIcon,
        },
      ],
    },
    {
      // Its own destination, not folded into Reports: it is the page an
      // operations lead opens daily, and burying a daily page two clicks deep
      // to tidy a menu is a bad trade.
      heading: t('nav.agentPerformanceGroup', { defaultValue: 'Agents' }),
      items: [
        {
          to: '/agent-performance',
          requires: 'view_all_chats' as const,
          label: t('nav.agentPerformance', { defaultValue: 'Agent performance' }),
          icon: ClockIcon,
        },
      ],
    },
    {
      heading: t('nav.couponApprovalsGroup', { defaultValue: 'Coupons' }),
      items: [
        {
          to: '/coupon-approvals',
          requires: 'approve_coupons' as const,
          label: t('nav.couponApprovals', { defaultValue: 'Coupon approvals' }),
          icon: ShieldIcon,
        },
        {
          to: '/coupon-report',
          requires: 'approve_coupons' as const,
          label: t('nav.couponReport', { defaultValue: 'Admin statistics' }),
          icon: ShieldIcon,
        },
      ],
    },
    {
      heading: t('nav.workspace', { defaultValue: 'Workspace' }),
      items: [
        { to: '/users', label: t('nav.users'), icon: UsersIcon, requires: 'manage_users' as const },
        {
          to: '/roles',
          requires: 'manage_users' as const,
          label: t('nav.roles', { defaultValue: 'Roles & privileges' }),
          icon: ShieldIcon,
        },
        { to: '/teams', label: t('nav.teams'), icon: TeamIcon, requires: 'manage_users' as const },
        {
          to: '/vendors',
          label: t('nav.vendors', { defaultValue: 'Vendors' }),
          icon: StoreIcon,
          requires: 'manage_restaurants' as const,
        },
        {
          to: '/lists',
          requires: 'manage_lists' as const,
          label: t('nav.lists', { defaultValue: 'Dropdown lists' }),
          icon: SettingsIcon,
        },
        {
          to: '/backup',
          requires: 'manage_users' as const,
          label: t('nav.backup', { defaultValue: 'Backup' }),
          icon: DownloadIcon,
        },
      ],
    },
    {
      heading: t('nav.restaurants', { defaultValue: 'Restaurants' }),
      items: [
        {
          to: '/brands',
          label: t('nav.brands', { defaultValue: 'Brands' }),
          icon: StoreIcon,
          requires: 'manage_restaurants' as const,
        },
        {
          to: '/stores',
          label: t('nav.stores', { defaultValue: 'Stores' }),
          icon: StoreIcon,
          requires: 'manage_restaurants' as const,
        },
        {
          to: '/store-notifications',
          requires: 'manage_restaurants' as const,
          label: t('nav.storeNotifications', { defaultValue: 'Branch notifications' }),
          icon: StoreIcon,
        },
      ],
    },
    // A "Tickets" section used to sit here, pointing at Ticket breakdown.
    // It was the SAME page as Reports -> Operational KPI -> Ticket breakdown,
    // so the bar carried the destination twice and lit both pills at once.
    {
      heading: t('nav.policies', { defaultValue: 'Policies' }),
      items: [
        { to: '/sla', label: t('nav.sla'), icon: ShieldIcon, requires: 'manage_lists' as const },
      ],
    },
    {
      heading: t('nav.intelligence', { defaultValue: 'Intelligence' }),
      items: [
        {
          to: '/ai-config',
          requires: 'manage_lists' as const,
          // A single-item section shows the ITEM label in the top bar, so this
          // is the word that has to fit there. The page keeps its full title.
          label: t('nav.aiConfigShort', { defaultValue: 'AI' }),
          icon: SparkleIcon,
        },
      ],
    },
  ];

  /**
   * The nav this ROLE gets: destinations whose privilege they hold, and only
   * the sections still holding a destination.
   *
   * Built here rather than inside TopNav so the rail in the mobile drawer and
   * the top bar cannot disagree about what exists — they render the same array.
   * The tuple type is restored with a cast because filtering cannot prove
   * non-emptiness to the compiler; the `length` guard above it is the proof.
   */
  /**
   * How many reports each group page would actually show this role.
   *
   * A group whose strip has collapsed to a single report is not a group any
   * more — it IS that report. Operations could reach exactly one thing under
   * Operational KPI, Ticket breakdown, which already has its own entry in the
   * bar: the same page, listed twice, under two different names, one of them
   * jargon. Dropping the group leaves "Dashboard | Tickets", which is the whole
   * of what that role does.
   *
   * Counted rather than hardcoded, so this stays true as tabs and privileges
   * move — the collapse only ever removes a duplicate, never a destination.
   *
   * Since Compensation moved to Agent KPI (2026-09-03) this group holds ONE
   * tab, so the collapse now fires for every role and "Operational KPI"
   * renders as "Ticket breakdown". That is the intended reading: a group of
   * one is the same place named twice. Left counted rather than simplified
   * away, so adding a second operations report restores the group by itself.
   */
  const visibleTabs = (group: { to: string; requires?: Privilege }[]) =>
    group.filter((tab) => !tab.requires || can(tab.requires));
  const opsKpiCollapsedToTickets =
    visibleTabs(tabs.opsKpi).length === 1 && visibleTabs(tabs.opsKpi)[0]?.to === 'tickets';

  const sections: NavSection[] = allSections
    .map((section) => ({
      ...section,
      items: section.items.flatMap((it) => {
        if (it.requires && !can(it.requires)) return [];
        /*
         * A group that collapses to ONE tab becomes that tab.
         *
         * This used to just drop the group and add nothing back, on the
         * reasoning that a "Operational KPI → Ticket breakdown" pair with one
         * leaf is the same destination named twice. True — but for a role that
         * can see only Ticket breakdown, dropping the group dropped its ONLY
         * report, the Reports section then had no items and was filtered out
         * whole, and an Operations user was left with a top bar containing
         * Dashboard and nothing else. The duplicate was worth removing; the
         * destination was not.
         */
        if (it.to === '/reports/operational-kpi' && opsKpiCollapsedToTickets) {
          return [
            {
              ...it,
              to: '/reports/operational-kpi/tickets',
              label: t('nav.reportTickets', { defaultValue: 'Ticket breakdown' }),
            },
          ];
        }
        return [it];
      }),
    }))
    .filter((section) => section.items.length > 0) as NavSection[];

  // ONE floating bar (the owner's reference layout — no sidebars): brand at
  // the start, the grouped nav pills in the middle, utilities at the end. The
  // rail still exists but only as the mobile drawer.
  return (
    <>
      <AppShell
        rail={(ctx) => <Rail ctx={ctx} sections={sections} />}
        topBarBrand={<MobileBrand />}
        topBarActions={
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <PageRefresh />
            <HelpAssistant />
          </div>
        }
        navBar={<TopNav sections={sections} />}
        topBar={
          <>
            {/* The bar is a card surface now, so the utility triggers read
                correctly with their own tokens — no rebinding needed. */}
            <div className="flex items-center gap-0.5 rounded-full bg-ink-foreground/10 p-1 ring-1 ring-ink-foreground/15">
              {/* In the masthead, so it is on every page without thirty copies
                  of it — thirty chances for one to be wired to the wrong
                  thing. */}
              <PageRefresh />
              <HelpAssistant />
              {/* The bell belongs on the masthead for the same reason as the
                  rest of this bar: an alert nobody can see without opening the
                  right page is not an alert. */}
              <NotificationBell />
              <LanguageToggle />
            </div>
            <span className="hidden items-center gap-2 rounded-full bg-ink-foreground/10 py-1 pe-1 ps-1 ring-1 ring-ink-foreground/15 sm:flex">
              <Avatar name={displayName} email={user?.email} size="sm" />
              <span className="max-w-[9rem] truncate text-xs font-semibold text-ink-foreground">
                {displayName}
              </span>
              <button
                type="button"
                onClick={() => void logout()}
                aria-label={t('auth.signOut', { ns: 'common' })}
                title={t('auth.signOut', { ns: 'common' })}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] duration-fast ease-out hover:bg-secondary hover:text-foreground motion-safe:active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <SignOutIcon size={14} />
              </button>
            </span>
          </>
        }
        resizeStorageKey="yiji.admin.sidebarWidth"
        navLabel={t('nav.primary', { defaultValue: 'Primary navigation' })}
        menuLabel={t('nav.openMenu', { defaultValue: 'Open menu' })}
        closeLabel={t('nav.closeMenu', { defaultValue: 'Close menu' })}
      >
        <ErrorBoundary
          resetKeys={[location.pathname]}
          fallback={({ reset }) => <RouteError onRetry={reset} />}
        >
          <Suspense
            fallback={
              <div
                className="flex h-full items-center justify-center text-muted-foreground"
                aria-busy="true"
              >
                <Spinner size={20} label={t('actions.loading', { ns: 'common' })} />
              </div>
            }
          >
            {/* Keyed on the route so each page settles up into place once. */}
            <div key={location.pathname} className="h-full min-h-0 motion-safe:animate-rise-in">
              {children}
            </div>
          </Suspense>
        </ErrorBoundary>
      </AppShell>
      <AppCommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {/* Says so when this tab is running a build the server has replaced. */}
      <NewVersionBanner />
      <AppKeyboardShortcuts />
      <Toaster position="bottom" />
    </>
  );
}

/**
 * The second level, one strip per KPI group.
 *
 * Paths are RELATIVE to the group route, so the strip does not have to know
 * where its group is mounted and moving a group is one edit.
 *
 * Built from `t` at render rather than frozen at import, so switching language
 * relabels the tabs like everything else.
 */
/**
 * Where the compensation report lives.
 *
 * Named because THREE places point at it — the tab, the legacy `/compensation`
 * link and the old Operational-KPI URL — and a move that updates two of them
 * leaves a redirect pointing at a 404 nobody notices until someone follows an
 * old bookmark.
 */
const COMPENSATION_PATH = '/reports/agent-kpi/compensation';

function reportTabs(t: TFunction) {
  return {
    agentKpi: [
      {
        to: 'tickets',
        label: t('nav.reportAgents', { defaultValue: 'Agent summary' }),
        requires: 'view_all_chats' as const,
      },
      {
        to: 'sla',
        label: t('nav.slaReports', { defaultValue: 'Ticket deadlines' }),
        requires: 'view_all_tickets' as const,
      },
      {
        to: 'conversations',
        label: t('nav.reportConversations', { defaultValue: 'Chat status' }),
        requires: 'view_all_chats' as const,
      },
      {
        // Compensation is a money screen, so it follows the coupon privilege
        // rather than the chat one it happens to sit beside.
        to: 'compensation',
        label: t('nav.compensationAll', { defaultValue: 'Compensation' }),
        requires: 'approve_coupons' as const,
      },
    ],
    opsKpi: [
      {
        to: 'tickets',
        label: t('nav.reportTickets', { defaultValue: 'Ticket breakdown' }),
        requires: 'view_all_tickets' as const,
      },
    ],
  };
}

export function App() {
  const { t } = useTranslation();
  const tabs = reportTabs(t);
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Public: reached from the emailed Directus reset link (FR-001). */}
          <Route path={RESET_PASSWORD_PATH} element={<ResetPassword />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute requires="view_dashboard">
                <Shell>
                  <DashboardPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/users"
            element={
              <ProtectedRoute requires="manage_users">
                <Shell>
                  <UsersPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/teams"
            element={
              <ProtectedRoute requires="manage_users">
                <Shell>
                  <TeamsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/sla"
            element={
              <ProtectedRoute requires="manage_lists">
                <Shell>
                  <SlaPoliciesPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/vendors"
            element={
              <ProtectedRoute requires="manage_restaurants">
                <Shell>
                  <VendorsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/brands"
            element={
              <ProtectedRoute requires="manage_restaurants">
                <Shell>
                  <BrandsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/stores"
            element={
              <ProtectedRoute requires="manage_restaurants">
                <Shell>
                  <StoresPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/ai-config"
            element={
              <ProtectedRoute requires="manage_lists">
                <Shell>
                  <AiConfigPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          {/* ── Reports: three destinations, each with its own tab strip ──
              Every report keeps a real URL, so a bookmark or a link in an
              email still lands on the report itself rather than on a menu. */}
          <Route path="/reports" element={<Navigate to="/reports/agent-kpi" replace />} />
          <Route
            path="/reports/scheduled"
            element={
              <ProtectedRoute requires="manage_lists">
                <Shell>
                  <ReportsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports/agent-kpi"
            element={
              <ProtectedRoute requires="view_all_chats">
                <Shell>
                  <ReportGroupTabs tabs={tabs.agentKpi} />
                </Shell>
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="tickets" replace />} />
            <Route
              path="tickets"
              element={
                <ProtectedRoute requires="view_all_chats">
                  <ReportExportsPage report="agents" />
                </ProtectedRoute>
              }
            />
            <Route
              path="sla"
              element={
                <ProtectedRoute requires="view_all_tickets">
                  <SlaReportsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="conversations"
              element={
                <ProtectedRoute requires="view_all_chats">
                  <ReportExportsPage report="conversations" />
                </ProtectedRoute>
              }
            />
            <Route
              path="compensation"
              element={
                <ProtectedRoute requires="approve_coupons">
                  <AllCompensationPage />
                </ProtectedRoute>
              }
            />
          </Route>
          <Route
            path="/reports/operational-kpi"
            element={
              <ProtectedRoute requires="view_all_tickets">
                <Shell>
                  <ReportGroupTabs tabs={tabs.opsKpi} />
                </Shell>
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="tickets" replace />} />
            <Route
              path="tickets"
              element={
                <ProtectedRoute requires="view_all_tickets">
                  <ReportExportsPage report="complaints" />
                </ProtectedRoute>
              }
            />
            {/* Compensation moved to Agent KPI (owner's call, 2026-09-03) — it
                reports what agents gave away, which is an agent measure. The
                redirect below keeps existing links and bookmarks working. */}
            <Route path="compensation" element={<Navigate to={COMPENSATION_PATH} replace />} />
          </Route>
          {/* The Complaints report was merged into Tickets — same records,
              one page. Redirect so existing links and bookmarks still land. */}
          <Route path="/report-complaints" element={<Navigate to="/report-tickets" replace />} />
          <Route
            path="/report-tickets"
            element={<Navigate to="/reports/operational-kpi/tickets" replace />}
          />
          <Route
            path="/coupon-approvals"
            element={
              <ProtectedRoute requires="approve_coupons">
                <Shell>
                  <CouponApprovalsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route path="/compensation" element={<Navigate to={COMPENSATION_PATH} replace />} />
          <Route
            path="/coupon-report"
            element={
              <ProtectedRoute requires="approve_coupons">
                <Shell>
                  <CouponReportPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/store-notifications"
            element={
              <ProtectedRoute requires="manage_restaurants">
                <Shell>
                  <StoreNotificationsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/agent-performance"
            element={
              <ProtectedRoute requires="view_all_chats">
                <Shell>
                  <AgentPerformancePage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/report-agents"
            element={<Navigate to="/reports/agent-kpi/tickets" replace />}
          />
          <Route
            path="/report-conversations"
            element={<Navigate to="/reports/agent-kpi/conversations" replace />}
          />
          {/* Old combined route → first individual report. */}
          <Route path="/report-exports" element={<Navigate to="/report-tickets" replace />} />
          {/* Automation and Custom fields are disabled for now — hidden from the
              nav, routes redirect so old links do not dead-end. */}
          <Route path="/automation" element={<Navigate to="/sla" replace />} />
          <Route path="/custom-fields" element={<Navigate to="/sla" replace />} />
          {/* Ticket report was merged away: analytics -> dashboard, register ->
              Tickets, workload -> Agent KPI. Redirect rather than 404. */}
          <Route path="/ticket-ops" element={<Navigate to="/dashboard" replace />} />
          <Route path="/sla-reports" element={<Navigate to="/reports/agent-kpi/sla" replace />} />
          <Route
            path="/lists"
            element={
              <ProtectedRoute requires="manage_lists">
                <Shell>
                  <OptionListsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/roles"
            element={
              <ProtectedRoute requires="manage_users">
                <Shell>
                  <RolesPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/backup"
            element={
              <ProtectedRoute requires="manage_users">
                <Shell>
                  <BackupPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          {/* No /imports route.
              "Import contacts" bulk-loaded CUSTOMERS from a CSV, and it sat in
              the admin console — where nobody who talks to customers can reach
              it, and where the job it does has no bearing on anything else on
              the page. Customers arrive here by chatting, by ordering, or from
              the Yiji app; a spreadsheet of them was answering a question this
              business does not ask. Removed rather than moved: the agent portal
              has no use for it either. */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
