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
  UploadIcon,
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
const ImportsPage = lazy(() =>
  import('./features/imports/ImportsPage.js').then((m) => ({ default: m.ImportsPage })),
);
const AiConfigPage = lazy(() =>
  import('./features/ai-config/AiConfigPage.js').then((m) => ({ default: m.AiConfigPage })),
);

import type { TFunction } from 'i18next';
import type { NavSection } from './nav.js';
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

/** Compact brand lockup for the mobile top bar. */
function MobileBrand() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-0.5 leading-none">
      {/* The supplied tile artwork rather than a traced lockup — it already
          carries the wordmark, so nothing beside it repeats the name. A raster
          is fine at one known masthead size, unlike the favicon which has to
          hold from 16px to 180px.

          STACKED, and that is what pays for the SIZE. The masthead shares its
          row with the primary nav and there is no slack in it — a tile beside
          the label pushed "Agent performance" into an ellipsis at 1440px. With
          the label UNDER the tile, the block is only as wide as its widest
          part, and the label is 71px, so every pixel of tile up to that is
          free. 56px is the largest square that still leaves the label room
          inside the 80px bar: twice the size, at no cost to the nav. */}
      <img
        src="/sara-crm-icon.png"
        alt="Sara CRM"
        /* No `rounded-*`: the artwork's corners are already cut, and its own
           radius is transparent — rounding the element again clips the
           corners a second time and shaves the tile. */
        className="h-14 w-14 shrink-0"
      />
      <span className="min-w-0 leading-none">
        <span className="block text-2xs leading-none text-ink-muted">
          {t('app.console', { defaultValue: 'Admin console' })}
        </span>
      </span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const { user, logout } = useAuth();
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
  const sections: NavSection[] = [
    {
      heading: t('nav.overview', { defaultValue: 'Overview' }),
      items: [
        {
          to: '/dashboard',
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
          label: t('nav.agentKpiGroup', { defaultValue: 'Agent KPI' }),
          icon: DownloadIcon,
        },
        {
          to: '/reports/operational-kpi',
          label: t('nav.opsKpiGroup', { defaultValue: 'Operational KPI' }),
          icon: DownloadIcon,
        },
        {
          // NOT `/reports`: that is now the parent of the two KPI pages, so a
          // link to it would light up alongside whichever one is open.
          to: '/reports/scheduled',
          label: t('nav.reports', { defaultValue: 'Scheduled reports' }),
          icon: CalendarIcon,
        },
      ],
    },
    {
      // Its own destination, not folded into Reports: it is the page an
      // operations lead opens daily, and burying a daily page two clicks deep
      // to tidy a menu is a bad trade.
      heading: t('nav.agentPerformanceGroup', { defaultValue: 'Agent performance' }),
      items: [
        {
          to: '/agent-performance',
          label: t('nav.agentPerformance', { defaultValue: 'Agent performance' }),
          icon: ClockIcon,
        },
      ],
    },
    {
      heading: t('nav.couponApprovalsGroup', { defaultValue: 'Coupon approvals' }),
      items: [
        {
          to: '/coupon-approvals',
          label: t('nav.couponApprovals', { defaultValue: 'Coupon approvals' }),
          icon: ShieldIcon,
        },
        {
          to: '/coupon-report',
          label: t('nav.couponReport', { defaultValue: 'Admin statistics' }),
          icon: ShieldIcon,
        },
      ],
    },
    {
      heading: t('nav.workspace', { defaultValue: 'Workspace' }),
      items: [
        { to: '/users', label: t('nav.users'), icon: UsersIcon },
        {
          to: '/roles',
          label: t('nav.roles', { defaultValue: 'Roles & privileges' }),
          icon: ShieldIcon,
        },
        { to: '/teams', label: t('nav.teams'), icon: TeamIcon },
        { to: '/vendors', label: t('nav.vendors', { defaultValue: 'Vendors' }), icon: StoreIcon },
        {
          to: '/lists',
          label: t('nav.lists', { defaultValue: 'Dropdown lists' }),
          icon: SettingsIcon,
        },
        {
          to: '/imports',
          label: t('nav.imports', { defaultValue: 'Import contacts' }),
          icon: UploadIcon,
        },
        {
          to: '/backup',
          label: t('nav.backup', { defaultValue: 'Backup' }),
          icon: DownloadIcon,
        },
      ],
    },
    {
      heading: t('nav.restaurants', { defaultValue: 'Restaurants' }),
      items: [
        { to: '/brands', label: t('nav.brands', { defaultValue: 'Brands' }), icon: StoreIcon },
        { to: '/stores', label: t('nav.stores', { defaultValue: 'Stores' }), icon: StoreIcon },
        {
          to: '/store-notifications',
          label: t('nav.storeNotifications', { defaultValue: 'Branch notifications' }),
          icon: StoreIcon,
        },
      ],
    },
    {
      heading: t('nav.policies', { defaultValue: 'Policies' }),
      items: [{ to: '/sla', label: t('nav.sla'), icon: ShieldIcon }],
    },
    {
      heading: t('nav.intelligence', { defaultValue: 'Intelligence' }),
      items: [
        {
          to: '/ai-config',
          label: t('nav.aiConfig', { defaultValue: 'AI assistance' }),
          icon: SparkleIcon,
        },
      ],
    },
  ];
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
function reportTabs(t: TFunction) {
  return {
    agentKpi: [
      { to: 'tickets', label: t('nav.reportAgents', { defaultValue: 'Agent KPI' }) },
      { to: 'sla', label: t('nav.slaReports', { defaultValue: 'SLA performance' }) },
      {
        to: 'conversations',
        label: t('nav.reportConversations', { defaultValue: 'Conversation status' }),
      },
    ],
    opsKpi: [
      { to: 'tickets', label: t('nav.reportTickets', { defaultValue: 'Tickets' }) },
      { to: 'compensation', label: t('nav.compensationAll', { defaultValue: 'Compensation' }) },
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
              <ProtectedRoute>
                <Shell>
                  <DashboardPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/users"
            element={
              <ProtectedRoute>
                <Shell>
                  <UsersPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/teams"
            element={
              <ProtectedRoute>
                <Shell>
                  <TeamsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/sla"
            element={
              <ProtectedRoute>
                <Shell>
                  <SlaPoliciesPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/vendors"
            element={
              <ProtectedRoute>
                <Shell>
                  <VendorsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/brands"
            element={
              <ProtectedRoute>
                <Shell>
                  <BrandsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/stores"
            element={
              <ProtectedRoute>
                <Shell>
                  <StoresPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/ai-config"
            element={
              <ProtectedRoute>
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
              <ProtectedRoute>
                <Shell>
                  <ReportsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports/agent-kpi"
            element={
              <ProtectedRoute>
                <Shell>
                  <ReportGroupTabs tabs={tabs.agentKpi} />
                </Shell>
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="tickets" replace />} />
            <Route path="tickets" element={<ReportExportsPage report="agents" />} />
            <Route path="sla" element={<SlaReportsPage />} />
            <Route path="conversations" element={<ReportExportsPage report="conversations" />} />
          </Route>
          <Route
            path="/reports/operational-kpi"
            element={
              <ProtectedRoute>
                <Shell>
                  <ReportGroupTabs tabs={tabs.opsKpi} />
                </Shell>
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="tickets" replace />} />
            <Route path="tickets" element={<ReportExportsPage report="complaints" />} />
            <Route path="compensation" element={<AllCompensationPage />} />
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
              <ProtectedRoute>
                <Shell>
                  <CouponApprovalsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/compensation"
            element={<Navigate to="/reports/operational-kpi/compensation" replace />}
          />
          <Route
            path="/coupon-report"
            element={
              <ProtectedRoute>
                <Shell>
                  <CouponReportPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/store-notifications"
            element={
              <ProtectedRoute>
                <Shell>
                  <StoreNotificationsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/agent-performance"
            element={
              <ProtectedRoute>
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
              <ProtectedRoute>
                <Shell>
                  <OptionListsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/roles"
            element={
              <ProtectedRoute>
                <Shell>
                  <RolesPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/backup"
            element={
              <ProtectedRoute>
                <Shell>
                  <BackupPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/imports"
            element={
              <ProtectedRoute>
                <Shell>
                  <ImportsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
