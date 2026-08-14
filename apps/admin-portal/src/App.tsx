import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AppShell,
  type AppShellRailContext,
  Avatar,
  CalendarIcon,
  ChartIcon,
  ClockIcon,
  cn,
  DownloadIcon,
  ErrorBoundary,
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
  YijiLogo,
} from '@yiji/ui';
import { RouteError } from './components/RouteError.js';
import { TopNav } from './components/TopNav.js';
import { AuthProvider, useAuth } from './lib/auth/AuthContext.js';
import { ProtectedRoute } from './lib/auth/ProtectedRoute.js';
import { Login } from './pages/Login.js';
import { ResetPassword, RESET_PASSWORD_PATH } from './pages/ResetPassword.js';
import { LanguageToggle } from './components/LanguageToggle.js';
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

import type { NavSection } from './nav.js';

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
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || '';
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
        <YijiLogo variant="tile" size={32} className="bg-background/95 shadow-sm shrink-0" />
        {!isCollapsed && (
          <div className="min-w-0 leading-tight">
            <div
              dir="ltr"
              className="flex items-baseline gap-1.5 text-[15px] font-semibold tracking-[-0.015em] text-rail-active-foreground"
            >
              <span>Yiji</span>
              <span className="text-rail-foreground/70 font-normal">CRM</span>
            </div>
            <div className="text-2xs text-rail-foreground/75 mt-0.5">
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
  return (
    <div className="flex items-center gap-2">
      <YijiLogo variant="tile" size={28} className="bg-rail shadow-sm shrink-0" />
      <span dir="ltr" className="text-[15px] font-semibold tracking-[-0.015em] text-foreground">
        Yiji <span className="font-normal text-muted-foreground">CRM</span>
      </span>
      {/* Build marker: if this tag is not on screen, the browser is NOT on the
          current build — the one diagnostic nobody can argue with. */}
      <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-2xs font-bold tracking-wide text-primary ring-1 ring-inset ring-primary/25">
        v2
      </span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const { user, logout } = useAuth();
  const displayName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || 'Admin';
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
      items: [
        {
          to: '/sla-reports',
          label: t('nav.slaReports', { defaultValue: 'SLA performance' }),
          icon: ClockIcon,
        },
        {
          // One report. A complaint IS a ticket here — two entries listing the
          // same records under different names only raised the question of
          // which one was authoritative.
          to: '/report-tickets',
          label: t('nav.reportTickets', { defaultValue: 'Tickets' }),
          icon: DownloadIcon,
        },
        {
          to: '/report-agents',
          label: t('nav.reportAgents', { defaultValue: 'Agent KPI' }),
          icon: DownloadIcon,
        },
        {
          to: '/report-conversations',
          label: t('nav.reportConversations', { defaultValue: 'Conversation status' }),
          icon: DownloadIcon,
        },
        {
          to: '/reports',
          label: t('nav.reports', { defaultValue: 'Scheduled reports' }),
          icon: CalendarIcon,
        },
      ],
    },
    {
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
            <HelpAssistant />
          </div>
        }
        navBar={<TopNav sections={sections} />}
        topBar={
          <>
            {/* The bar is a card surface now, so the utility triggers read
                correctly with their own tokens — no rebinding needed. */}
            <div className="flex items-center gap-0.5 rounded-full bg-secondary/50 p-1 ring-1 ring-border">
              <HelpAssistant />
              <LanguageToggle />
            </div>
            <span className="hidden items-center gap-2 rounded-full bg-secondary/50 py-1 pe-1 ps-1 ring-1 ring-border sm:flex">
              <Avatar name={displayName} email={user?.email} size="sm" />
              <span className="max-w-[9rem] truncate text-xs font-semibold text-foreground">
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
      <AppKeyboardShortcuts />
      <Toaster position="bottom" />
    </>
  );
}

export function App() {
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
          <Route
            path="/reports"
            element={
              <ProtectedRoute>
                <Shell>
                  <ReportsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          {/* The Complaints report was merged into Tickets — same records,
              one page. Redirect so existing links and bookmarks still land. */}
          <Route path="/report-complaints" element={<Navigate to="/report-tickets" replace />} />
          <Route
            path="/report-tickets"
            element={
              <ProtectedRoute>
                <Shell>
                  <ReportExportsPage report="complaints" />
                </Shell>
              </ProtectedRoute>
            }
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
            element={
              <ProtectedRoute>
                <Shell>
                  <ReportExportsPage report="agents" />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/report-conversations"
            element={
              <ProtectedRoute>
                <Shell>
                  <ReportExportsPage report="conversations" />
                </Shell>
              </ProtectedRoute>
            }
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
          <Route
            path="/sla-reports"
            element={
              <ProtectedRoute>
                <Shell>
                  <SlaReportsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
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
