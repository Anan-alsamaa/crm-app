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
const CouponsPage = lazy(() =>
  import('./features/coupons/CouponsPage.js').then((m) => ({ default: m.CouponsPage })),
);
const ComingNextPage = lazy(() =>
  import('./features/coming/ComingNextPage.js').then((m) => ({ default: m.ComingNextPage })),
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
    { items: [item('/overview', t('nav.overview', { defaultValue: 'Overview' }), ChartIcon)] },
    {
      heading: t('nav.work', { defaultValue: 'Marketing' }),
      items: [
        item(
          '/coupons',
          t('nav.coupons', { defaultValue: 'Coupons' }),
          TicketIcon,
          'manage_marketing',
        ),
        item(
          '/bulk',
          t('nav.bulk', { defaultValue: 'Bulk coupons' }),
          UsersIcon,
          'manage_marketing',
        ),
        item(
          '/campaigns',
          t('nav.campaigns', { defaultValue: 'Campaigns' }),
          CalendarIcon,
          'manage_marketing',
        ),
        item(
          '/points',
          t('nav.points', { defaultValue: 'Points' }),
          SparkleIcon,
          'manage_marketing',
        ),
      ],
    },
    {
      heading: t('nav.control', { defaultValue: 'Control' }),
      items: [
        item(
          '/approvals',
          t('nav.approvals', { defaultValue: 'Approvals' }),
          ShieldIcon,
          'approve_marketing',
        ),
        item('/activity', t('nav.activity', { defaultValue: 'Activity log' }), ClockIcon),
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

function Coming({
  titleKey,
  title,
  descKey,
  desc,
}: {
  titleKey: string;
  title: string;
  descKey: string;
  desc: string;
}) {
  const { t } = useTranslation();
  return (
    <ComingNextPage
      title={t(titleKey, { defaultValue: title })}
      description={t(descKey, { defaultValue: desc })}
    />
  );
}

export function App() {
  return (
    <AuthProvider>
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
            path="/coupons"
            element={
              <Gate requires="manage_marketing">
                <CouponsPage />
              </Gate>
            }
          />
          <Route
            path="/bulk"
            element={
              <Gate requires="manage_marketing">
                <Coming
                  titleKey="bulk.title"
                  title="Bulk coupons"
                  descKey="bulk.desc"
                  desc="Upload a list of phone numbers, check every number first, and send one coupon to all of them at a pace Yiji can take."
                />
              </Gate>
            }
          />
          <Route
            path="/campaigns"
            element={
              <Gate requires="manage_marketing">
                <Coming
                  titleKey="campaigns.title"
                  title="Campaigns"
                  descKey="campaigns.desc"
                  desc="Group coupons and offers under one campaign with its dates, budget and results."
                />
              </Gate>
            }
          />
          <Route
            path="/points"
            element={
              <Gate requires="manage_marketing">
                <Coming
                  titleKey="points.title"
                  title="Points"
                  descKey="points.desc"
                  desc="Loyalty points rules and programmes on Yiji. Needs the marketing Yiji account."
                />
              </Gate>
            }
          />
          <Route
            path="/approvals"
            element={
              <Gate requires="approve_marketing">
                <ApprovalsPage />
              </Gate>
            }
          />
          <Route
            path="/activity"
            element={
              <Gate>
                <ActivityPage />
              </Gate>
            }
          />
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
