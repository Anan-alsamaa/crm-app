import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { staffDisplayName } from '@yiji/shared-types';
import {
  Avatar,
  CalendarIcon,
  ChartIcon,
  ClockIcon,
  ErrorBoundary,
  NewVersionBanner,
  ShieldIcon,
  SignOutIcon,
  SparkleIcon,
  Spinner,
  TicketIcon,
  Toaster,
  UsersIcon,
  cn,
  type AppShellRailContext,
} from '@yiji/ui';
import { RouteError } from './components/RouteError.js';
import { TopNav } from './components/TopNav.js';
import { AdminShell } from './components/shell/AdminShell.js';
import { LanguageToggle } from './components/LanguageToggle.js';
import { AuthProvider, useAuth } from './lib/auth/AuthContext.js';
import { ProtectedRoute } from './lib/auth/ProtectedRoute.js';
import { Login } from './pages/Login.js';
import { ResetPassword, RESET_PASSWORD_PATH } from './pages/ResetPassword.js';
import { navItemAllowed, type NavItem, type NavSection } from './nav.js';
import { EngineProvider } from './engine/index.js';
import type { Privilege } from './lib/privileges.js';

const OverviewPage = lazy(() =>
  import('./features/overview/OverviewPage.js').then((m) => ({ default: m.OverviewPage })),
);
const ApprovalsPage = lazy(() =>
  import('./features/approvals/ApprovalsPage.js').then((m) => ({ default: m.ApprovalsPage })),
);
const ActivityPage = lazy(() =>
  import('./features/activity/ActivityPage.js').then((m) => ({ default: m.ActivityPage })),
);
const BulkPage = lazy(() =>
  import('./features/bulk/BulkPage.js').then((m) => ({ default: m.BulkPage })),
);
const CampaignsPage = lazy(() =>
  import('./features/campaigns/CampaignsPage.js').then((m) => ({ default: m.CampaignsPage })),
);
const PointsPage = lazy(() =>
  import('./features/points/PointsPage.js').then((m) => ({ default: m.PointsPage })),
);
const CouponsPage = lazy(() =>
  import('./features/coupons/CouponsPage.js').then((m) => ({ default: m.CouponsPage })),
);
/* THE PROMOTIONS PORTAL (owner, 2026-11-15): the operations draft's seven
   areas, over the promotion engine (sample data today, Yiji v2 when it ships). */
const HomePage = lazy(() =>
  import('./features/promo/HomePage.js').then((m) => ({ default: m.HomePage })),
);
const AlertsPage = lazy(() =>
  import('./features/promo/HomePage.js').then((m) => ({ default: m.AlertsPage })),
);
const CouponTypesPage = lazy(() =>
  import('./features/promo/CouponsPages.js').then((m) => ({ default: m.CouponTypesPage })),
);
const AllCouponsPage = lazy(() =>
  import('./features/promo/CouponsPages.js').then((m) => ({ default: m.AllCouponsPage })),
);
const CampaignApprovalsPage = lazy(() =>
  import('./features/promo/CouponsPages.js').then((m) => ({ default: m.CampaignApprovalsPage })),
);
const CampaignWizardPage = lazy(() =>
  import('./features/promo/CampaignWizard.js').then((m) => ({ default: m.CampaignWizardPage })),
);
const CampaignDetailPage = lazy(() =>
  import('./features/promo/CampaignDetailPage.js').then((m) => ({ default: m.CampaignDetailPage })),
);
const StudiesOverviewPage = lazy(() =>
  import('./features/promo/StudiesPages.js').then((m) => ({ default: m.StudiesOverviewPage })),
);
const StudiesDataPage = lazy(() =>
  import('./features/promo/StudiesPages.js').then((m) => ({ default: m.StudiesDataPage })),
);
const StudiesOpportunitiesPage = lazy(() =>
  import('./features/promo/StudiesPages.js').then((m) => ({ default: m.StudiesOpportunitiesPage })),
);
const StudiesCasesPage = lazy(() =>
  import('./features/promo/StudiesPages.js').then((m) => ({ default: m.StudiesCasesPage })),
);
const StudyDetailRoute = lazy(() =>
  import('./features/promo/StudiesPages.js').then((m) => ({ default: m.StudyDetailRoute })),
);
const StudiesGroupsPage = lazy(() =>
  import('./features/promo/StudiesPages.js').then((m) => ({ default: m.StudiesGroupsPage })),
);
const PerformanceOverviewPage = lazy(() =>
  import('./features/promo/PerformancePages.js').then((m) => ({
    default: m.PerformanceOverviewPage,
  })),
);
const PerformanceResultsPage = lazy(() =>
  import('./features/promo/PerformancePages.js').then((m) => ({
    default: m.PerformanceResultsPage,
  })),
);
const PerformancePlanPage = lazy(() =>
  import('./features/promo/PerformancePages.js').then((m) => ({ default: m.PerformancePlanPage })),
);
const PerformanceEvaluationsPage = lazy(() =>
  import('./features/promo/PerformancePages.js').then((m) => ({
    default: m.PerformanceEvaluationsPage,
  })),
);
const GiftCardsOverviewPage = lazy(() =>
  import('./features/promo/GiftCardsPages.js').then((m) => ({ default: m.GiftCardsOverviewPage })),
);
const GiftCardsProductsPage = lazy(() =>
  import('./features/promo/GiftCardsPages.js').then((m) => ({ default: m.GiftCardsProductsPage })),
);
const GiftCardsDesignPage = lazy(() =>
  import('./features/promo/GiftCardsPages.js').then((m) => ({ default: m.GiftCardsDesignPage })),
);
const GiftCardsActivityPage = lazy(() =>
  import('./features/promo/GiftCardsPages.js').then((m) => ({ default: m.GiftCardsActivityPage })),
);
const RewardsOverviewPage = lazy(() =>
  import('./features/promo/RewardsPages.js').then((m) => ({ default: m.RewardsOverviewPage })),
);
const RewardsEarnPage = lazy(() =>
  import('./features/promo/RewardsPages.js').then((m) => ({ default: m.RewardsEarnPage })),
);
const RewardsRedeemPage = lazy(() =>
  import('./features/promo/RewardsPages.js').then((m) => ({ default: m.RewardsRedeemPage })),
);
const RewardsMembersPage = lazy(() =>
  import('./features/promo/RewardsPages.js').then((m) => ({ default: m.RewardsMembersPage })),
);
const SettingsGeneralPage = lazy(() =>
  import('./features/promo/SettingsPages.js').then((m) => ({ default: m.SettingsGeneralPage })),
);
const SettingsStackingPage = lazy(() =>
  import('./features/promo/SettingsPages.js').then((m) => ({ default: m.SettingsStackingPage })),
);
const SettingsBrandsPage = lazy(() =>
  import('./features/promo/SettingsPages.js').then((m) => ({ default: m.SettingsBrandsPage })),
);
const SettingsFieldSpecPage = lazy(() =>
  import('./features/promo/SettingsPages.js').then((m) => ({ default: m.SettingsFieldSpecPage })),
);
const SettingsArchitecturePage = lazy(() =>
  import('./features/promo/SettingsPages.js').then((m) => ({
    default: m.SettingsArchitecturePage,
  })),
);

/**
 * THE MARKETING PORTAL'S MAP (owner, 2026-11-02): coupons, bulk sends,
 * campaigns and points, with a manager's approval before anything reaches a
 * customer, and a log of everything. Built from `t` at render so switching
 * language relabels it.
 */
export function marketingSections(t: (k: string, o: { defaultValue: string }) => string) {
  const item = (
    to: string,
    label: string,
    icon: NavItem['icon'],
    requires?: Privilege,
  ): NavItem => ({ to, label, icon, requires });
  const sections: NavSection[] = [
    { items: [item('/home', t('nav.home', { defaultValue: 'Home' }), ChartIcon)] },
    {
      heading: t('nav.promotions', { defaultValue: 'Promotions' }),
      items: [
        item(
          '/coupons',
          t('nav.coupons', { defaultValue: 'Coupons' }),
          TicketIcon,
          'manage_marketing',
        ),
        item(
          '/pre-studies',
          t('nav.preStudies', { defaultValue: 'Pre-studies' }),
          SparkleIcon,
          'manage_marketing',
        ),
        item('/performance', t('nav.performance', { defaultValue: 'Performance' }), ChartIcon),
        item(
          '/gift-cards',
          t('nav.giftCards', { defaultValue: 'Gift cards' }),
          UsersIcon,
          'manage_marketing',
        ),
        item(
          '/rewards',
          t('nav.rewards', { defaultValue: 'Rewards' }),
          CalendarIcon,
          'manage_marketing',
        ),
      ],
    },
    {
      heading: t('nav.control', { defaultValue: 'Control' }),
      items: [
        item(
          '/coupons/approvals',
          t('nav.approvals', { defaultValue: 'Approvals' }),
          ShieldIcon,
          'approve_marketing',
        ),
        item('/settings', t('nav.settings', { defaultValue: 'Settings' }), ClockIcon),
        item('/v1/activity', t('nav.activity', { defaultValue: 'Activity log' }), ClockIcon),
      ],
    },
    {
      heading: t('nav.v1', { defaultValue: 'Current Yiji (v1)' }),
      items: [
        item(
          '/v1/coupons',
          t('nav.v1Coupons', { defaultValue: 'Coupons (v1)' }),
          TicketIcon,
          'manage_marketing',
        ),
        item(
          '/v1/bulk',
          t('nav.bulk', { defaultValue: 'Bulk coupons' }),
          UsersIcon,
          'manage_marketing',
        ),
        item(
          '/v1/campaigns',
          t('nav.campaigns', { defaultValue: 'Campaigns' }),
          CalendarIcon,
          'manage_marketing',
        ),
        item(
          '/v1/points',
          t('nav.points', { defaultValue: 'Points' }),
          SparkleIcon,
          'manage_marketing',
        ),
        item(
          '/v1/approvals',
          t('nav.v1Approvals', { defaultValue: 'Approvals (v1)' }),
          ShieldIcon,
          'approve_marketing',
        ),
      ],
    },
  ];
  return sections;
}

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
          <img src="/sara-crm-icon.svg" alt="Sara CRM" className="h-8 w-8 shrink-0 rounded-lg" />
        ) : (
          <div className="flex min-w-0 items-center gap-2.5 leading-tight">
            <img src="/sara-crm-icon.svg" alt="Sara CRM" className="h-9 w-9 shrink-0 rounded-lg" />
            <div className="min-w-0 truncate text-2xs text-rail-foreground/75">
              {t('app.console', { defaultValue: 'Marketing portal' })}
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
              <h3 className="mb-1 px-2 text-xs font-semibold text-rail-foreground/70 whitespace-nowrap">
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
                  {name || 'Marketing'}
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

/** The mobile bar's brand: the logo tile alone, as in the admin portal. */
function MobileBrand() {
  return <img src="/sara-crm-icon.svg" alt="Sara CRM" className="h-10 w-10 shrink-0" />;
}

function Shell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const { user, logout, can, isOwner } = useAuth();
  const displayName = staffDisplayName(user, 'Marketing');
  /* Only what this role may open: a section left empty disappears with it. */
  const sections = useMemo(
    () =>
      marketingSections(t)
        .map((s) => ({ ...s, items: s.items.filter((it) => navItemAllowed(it, { can, isOwner })) }))
        .filter((s): s is NavSection => s.items.length > 0),
    [t, can, isOwner],
  );

  return (
    <>
      <AdminShell
        nav={<TopNav sections={sections} />}
        language={<LanguageToggle />}
        utilities={
          <span className="admin-icon-btn hidden gap-2 py-1 pe-1 ps-1 sm:flex">
            <Avatar name={displayName} email={user?.email} size="sm" />
            <span className="hidden max-w-[9rem] truncate text-xs font-semibold text-foreground 2xl:inline">
              {displayName}
            </span>
            <button
              type="button"
              onClick={() => void logout()}
              aria-label={t('auth.signOut', { ns: 'common' })}
              title={t('auth.signOut', { ns: 'common' })}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] duration-fast ease-out hover:bg-secondary hover:text-foreground motion-safe:active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <SignOutIcon size={14} />
            </button>
          </span>
        }
        mobileRail={(ctx) => <Rail ctx={ctx} sections={sections} />}
        mobileBrand={<MobileBrand />}
        mobileActions={null}
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
            <div key={location.pathname} className="h-full min-h-0 motion-safe:animate-rise-in">
              {children}
            </div>
          </Suspense>
        </ErrorBoundary>
      </AdminShell>
      <NewVersionBanner />
      <Toaster position="bottom" />
    </>
  );
}

/** A page behind the portal door and, optionally, its own privilege. */
function Gate({ children, requires }: { children: ReactNode; requires?: Privilege }) {
  return (
    <ProtectedRoute requires={requires}>
      <Shell>{children}</Shell>
    </ProtectedRoute>
  );
}

export function App() {
  return (
    <AuthProvider>
      <EngineProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path={RESET_PASSWORD_PATH} element={<ResetPassword />} />
            <Route
              path="/overview"
              element={
                <Gate>
                  <OverviewPage />
                </Gate>
              }
            />
            <Route
              path="/v1/coupons"
              element={
                <Gate requires="manage_marketing">
                  <CouponsPage />
                </Gate>
              }
            />
            <Route
              path="/v1/bulk"
              element={
                <Gate requires="manage_marketing">
                  <BulkPage />
                </Gate>
              }
            />
            <Route
              path="/v1/campaigns"
              element={
                <Gate requires="manage_marketing">
                  <CampaignsPage />
                </Gate>
              }
            />
            <Route
              path="/v1/points"
              element={
                <Gate requires="manage_marketing">
                  <PointsPage />
                </Gate>
              }
            />
            <Route
              path="/v1/approvals"
              element={
                <Gate requires="approve_marketing">
                  <ApprovalsPage />
                </Gate>
              }
            />
            <Route
              path="/v1/activity"
              element={
                <Gate>
                  <ActivityPage />
                </Gate>
              }
            />
            {/* The promotions portal */}
            <Route
              path="/home"
              element={
                <Gate>
                  <HomePage />
                </Gate>
              }
            />
            <Route
              path="/home/alerts"
              element={
                <Gate>
                  <AlertsPage />
                </Gate>
              }
            />
            <Route
              path="/coupons"
              element={
                <Gate requires="manage_marketing">
                  <CouponTypesPage />
                </Gate>
              }
            />
            <Route
              path="/coupons/all"
              element={
                <Gate requires="manage_marketing">
                  <AllCouponsPage />
                </Gate>
              }
            />
            <Route
              path="/coupons/approvals"
              element={
                <Gate requires="approve_marketing">
                  <CampaignApprovalsPage />
                </Gate>
              }
            />
            <Route
              path="/coupons/new"
              element={
                <Gate requires="manage_marketing">
                  <CampaignWizardPage />
                </Gate>
              }
            />
            <Route
              path="/coupons/:id"
              element={
                <Gate>
                  <CampaignDetailPage />
                </Gate>
              }
            />
            <Route
              path="/pre-studies"
              element={
                <Gate requires="manage_marketing">
                  <StudiesOverviewPage />
                </Gate>
              }
            />
            <Route
              path="/pre-studies/data"
              element={
                <Gate requires="manage_marketing">
                  <StudiesDataPage />
                </Gate>
              }
            />
            <Route
              path="/pre-studies/opportunities"
              element={
                <Gate requires="manage_marketing">
                  <StudiesOpportunitiesPage />
                </Gate>
              }
            />
            <Route
              path="/pre-studies/cases"
              element={
                <Gate requires="manage_marketing">
                  <StudiesCasesPage />
                </Gate>
              }
            />
            <Route
              path="/pre-studies/cases/:id"
              element={
                <Gate requires="manage_marketing">
                  <StudyDetailRoute />
                </Gate>
              }
            />
            <Route
              path="/pre-studies/groups"
              element={
                <Gate requires="manage_marketing">
                  <StudiesGroupsPage />
                </Gate>
              }
            />
            <Route
              path="/performance"
              element={
                <Gate>
                  <PerformanceOverviewPage />
                </Gate>
              }
            />
            <Route
              path="/performance/results"
              element={
                <Gate>
                  <PerformanceResultsPage />
                </Gate>
              }
            />
            <Route
              path="/performance/plan-vs-actual"
              element={
                <Gate>
                  <PerformancePlanPage />
                </Gate>
              }
            />
            <Route
              path="/performance/evaluations"
              element={
                <Gate>
                  <PerformanceEvaluationsPage />
                </Gate>
              }
            />
            <Route
              path="/gift-cards"
              element={
                <Gate requires="manage_marketing">
                  <GiftCardsOverviewPage />
                </Gate>
              }
            />
            <Route
              path="/gift-cards/products"
              element={
                <Gate requires="manage_marketing">
                  <GiftCardsProductsPage />
                </Gate>
              }
            />
            <Route
              path="/gift-cards/design"
              element={
                <Gate requires="manage_marketing">
                  <GiftCardsDesignPage />
                </Gate>
              }
            />
            <Route
              path="/gift-cards/activity"
              element={
                <Gate requires="manage_marketing">
                  <GiftCardsActivityPage />
                </Gate>
              }
            />
            <Route
              path="/rewards"
              element={
                <Gate requires="manage_marketing">
                  <RewardsOverviewPage />
                </Gate>
              }
            />
            <Route
              path="/rewards/earn"
              element={
                <Gate requires="manage_marketing">
                  <RewardsEarnPage />
                </Gate>
              }
            />
            <Route
              path="/rewards/redeem"
              element={
                <Gate requires="manage_marketing">
                  <RewardsRedeemPage />
                </Gate>
              }
            />
            <Route
              path="/rewards/members"
              element={
                <Gate requires="manage_marketing">
                  <RewardsMembersPage />
                </Gate>
              }
            />
            <Route
              path="/settings"
              element={
                <Gate>
                  <SettingsGeneralPage />
                </Gate>
              }
            />
            <Route
              path="/settings/stacking"
              element={
                <Gate>
                  <SettingsStackingPage />
                </Gate>
              }
            />
            <Route
              path="/settings/brands-menus"
              element={
                <Gate>
                  <SettingsBrandsPage />
                </Gate>
              }
            />
            <Route
              path="/settings/field-spec"
              element={
                <Gate>
                  <SettingsFieldSpecPage />
                </Gate>
              }
            />
            <Route
              path="/settings/architecture"
              element={
                <Gate>
                  <SettingsArchitecturePage />
                </Gate>
              }
            />
            <Route path="/overview" element={<Navigate to="/home" replace />} />
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
        </BrowserRouter>
      </EngineProvider>
    </AuthProvider>
  );
}
