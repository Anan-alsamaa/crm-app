import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import { staffDisplayName } from '@yiji/shared-types';
import { useTranslation } from 'react-i18next';
import {
  AddTicketIcon,
  AppShell,
  Avatar,
  ClockIcon,
  ErrorBoundary,
  InboxIcon,
  NewVersionBanner,
  SettingsIcon,
  SignOutIcon,
  Spinner,
  TicketIcon,
  Toaster,
  UsersIcon,
  SaraLogo,
  cn,
  type AppShellRailContext,
} from '@yiji/ui';
import { RouteError } from './components/RouteError.js';
import { AuthProvider, useAuth } from './lib/auth/AuthContext.js';
import { ProtectedRoute } from './lib/auth/ProtectedRoute.js';
import { Login } from './pages/Login.js';
import { ResetPassword, RESET_PASSWORD_PATH } from './pages/ResetPassword.js';
import { NotificationBell } from './features/notifications/NotificationBell.js';
import { HelpAssistant } from './features/help-assistant/HelpAssistant.js';
import { LanguageToggle } from './components/LanguageToggle.js';
import { PageRefresh } from './components/PageRefresh.js';
import { SoundToggle } from './components/SoundToggle.js';
import { AppCommandPalette } from './components/AppCommandPalette.js';
import { AppKeyboardShortcuts } from './components/AppKeyboardShortcuts.js';
import { NewMessageSound } from './components/NewMessageSound.js';

// Route pages are code-split so the initial bundle stays lean; each loads on
// first navigation behind the shared Suspense fallback below.
const Inbox = lazy(() => import('./pages/Inbox.js').then((m) => ({ default: m.Inbox })));
const TicketsPage = lazy(() =>
  import('./features/tickets/TicketsPage.js').then((m) => ({ default: m.TicketsPage })),
);
const NewTicketPage = lazy(() =>
  import('./features/tickets/NewTicketPage.js').then((m) => ({ default: m.NewTicketPage })),
);
const MyCouponsPage = lazy(() =>
  import('./features/coupons/MyCouponsPage.js').then((m) => ({ default: m.MyCouponsPage })),
);
const AgentPerformancePage = lazy(() =>
  import('./features/performance/AgentPerformancePage.js').then((m) => ({
    default: m.AgentPerformancePage,
  })),
);
const PreferencesPage = lazy(() =>
  import('./features/notifications/PreferencesPage.js').then((m) => ({
    default: m.PreferencesPage,
  })),
);
const ContactsPage = lazy(() =>
  import('./features/contacts/ContactsPage.js').then((m) => ({ default: m.ContactsPage })),
);
const CompensationPage = lazy(() =>
  import('./features/compensation/CompensationPage.js').then((m) => ({
    default: m.CompensationPage,
  })),
);
const ContactProfilePage = lazy(() =>
  import('./features/contacts/ContactProfilePage.js').then((m) => ({
    default: m.ContactProfilePage,
  })),
);

interface NavItem {
  to: string;
  end?: boolean;
  label: string;
  icon: typeof InboxIcon;
}

interface NavSection {
  heading?: string;
  items: NavItem[];
}

/* Aurora nav: each item's icon sits in its own tinted tile. */
const NAV_TILES = [
  'bg-sky/25 text-sky',
  'bg-violet/25 text-violet',
  'bg-rose-400/25 text-rose-300',
  'bg-orange-400/25 text-orange-300',
  'bg-emerald-400/25 text-emerald-300',
];

/*
 * Top-nav icon tiles, keyed by route so a hue belongs to a destination rather
 * than to a position in the list.
 *
 * These are the LIGHT-band tiles and use the `--<hue>-tint` fills, not a low
 * alpha of the accent: `bg-sky/25` is 25% of a dark blue over white, which
 * reads grey (DESIGN.md, "Tint ramp"). The rail keeps its alpha tiles above
 * because there they sit on dark, where an alpha genuinely lightens.
 *
 * `--warning` is deliberately excluded. It is a light token by design, so
 * `text-warning` on `bg-warning-tint` measures 2.09:1 — under the 3:1 that
 * WCAG 1.4.11 wants for a non-text glyph. The four hues used here measure
 * 3.74 / 5.28 / 3.78 / 3.84:1.
 *
 * Preferences is intentionally neutral rather than a fifth hue: flattening the
 * rail's two sections into one bar would otherwise lose the Work/Account
 * boundary, and the muted tile plus the divider carry it instead.
 */

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
        {/* The lockup NAMES the product, so the word beside it went — it was
            the same two words twice. What stays is which portal you are in,
            which the logo cannot tell you. */}
        {isCollapsed ? (
          <SaraLogo variant="mark" size={20} className="shrink-0 text-rail-foreground" />
        ) : (
          <div className="min-w-0 leading-tight">
            <SaraLogo size={17} className="text-rail-foreground" />
            <div className="text-2xs text-rail-foreground/75 mt-1">
              {t('app.workspace', { defaultValue: 'User workspace' })}
            </div>
          </div>
        )}
      </div>

      {/* Sections */}
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
                    end={it.end}
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

      {/* User footer */}
      <div
        className={cn(
          'shrink-0 border-t border-white/[0.06] py-2',
          isCollapsed ? 'px-2 space-y-1.5' : 'px-2.5 space-y-1',
        )}
      >
        {/* Utility controls (notifications bell, message-sound mute, language)
            live in the top navbar — see the AppShell `topBar` below. The rail
            footer is just the signed-in user + sign-out. */}
        <div
          className={cn(
            'flex items-center rounded-md',
            isCollapsed ? 'justify-center py-1' : 'gap-2 px-1 py-1',
          )}
        >
          <Avatar name={name} email={user?.email} size="sm" />
          {!isCollapsed && (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-rail-active-foreground leading-tight">
                  {name || 'Agent'}
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

/*
 * Horizontal primary nav — text pills in the floating top bar (the owner's
 * reference dashboards: rounded pills on a dark bar, no per-pill icon).
 *
 * The rail's sections flatten to a single row so every destination stays one
 * click away; the Work/Account boundary survives as a hairline divider. If a
 * viewport is too narrow for the row, the list scrolls sideways instead of
 * squishing the pills into ellipses (the scrollbar itself is hidden).
 */
function TopNav({ sections }: { sections: NavSection[] }) {
  const items = sections.flatMap((sec, sIdx) =>
    sec.items.map((it, iIdx) => ({ ...it, startsSection: sIdx > 0 && iIdx === 0 })),
  );
  return (
    <ul className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((it) => (
        <li key={it.to} className="flex items-center">
          {it.startsSection && <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-border" />}
          <NavLink
            to={it.to}
            end={it.end}
            className={({ isActive }) =>
              cn(
                // Solid dark pill for the current destination — see the admin
                // portal's TopNav for the reasoning.
                'relative flex h-10 items-center rounded-full px-4 text-sm whitespace-nowrap',
                'transition-[background-color,color,box-shadow,font-weight] duration-fast ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                'motion-safe:active:scale-[0.97]',
                isActive
                  ? 'bg-primary font-semibold text-primary-foreground shadow-[0_6px_18px_-8px_oklch(var(--primary)/0.7)] ring-1 ring-inset ring-primary-foreground/20'
                  : 'font-medium text-ink-foreground/60 hover:bg-ink-foreground/[0.12] hover:font-semibold hover:text-ink-foreground',
              )
            }
          >
            {it.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

/** Compact brand lockup for the mobile top bar. */
function MobileBrand() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5">
      {/* The lockup carries the name; the line under it carries which portal
          you are in, which a supervisor with both open actually needs. */}
      <span className="min-w-0 leading-tight">
        <SaraLogo size={18} className="text-ink-foreground" />
        <span className="mt-1 block text-2xs text-ink-muted">
          {t('app.workspace', { defaultValue: 'Agent workspace' })}
        </span>
      </span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const { user, logout } = useAuth();
  const displayName = staffDisplayName(user, 'Agent');
  // Command-palette open state is lifted here so the top-bar search trigger and
  // the Cmd/Ctrl+K shortcut both drive the one palette instance below.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sections: NavSection[] = [
    {
      heading: t('nav.work', { defaultValue: 'Work' }),
      items: [
        { to: '/', end: true, label: t('nav.inbox'), icon: InboxIcon },
        {
          to: '/new-ticket',
          label: t('nav.addTicket', { defaultValue: 'Add ticket' }),
          icon: AddTicketIcon,
        },
        { to: '/tickets', label: t('nav.tickets'), icon: TicketIcon },
        {
          to: '/contacts',
          label: t('nav.contacts', { defaultValue: 'Contacts' }),
          icon: UsersIcon,
        },
        {
          to: '/performance',
          label: t('nav.performance', { defaultValue: 'Agent performance' }),
          icon: ClockIcon,
        },
        {
          to: '/compensation',
          label: t('nav.compensation', { defaultValue: 'Compensation' }),
          icon: ClockIcon,
        },
      ],
    },
    {
      heading: t('nav.account', { defaultValue: 'Account' }),
      items: [{ to: '/preferences', label: t('nav.preferences'), icon: SettingsIcon }],
    },
  ];
  // ONE floating bar (the owner's reference layout — no sidebars): brand at
  // the start, the flat nav pills in the middle, utilities at the end. The
  // rail still exists but only as the mobile drawer.
  return (
    <>
      <AppShell
        rail={(ctx) => <Rail ctx={ctx} sections={sections} />}
        topBarBrand={<MobileBrand />}
        topBarActions={
          <div className="flex items-center gap-1.5 text-muted-foreground">
            {/* In the masthead, so it is on every page without thirty copies
                of it — thirty chances for one to be wired to the wrong
                thing. */}
            <PageRefresh />
            <NotificationBell />
            <HelpAssistant />
            <SoundToggle />
            <LanguageToggle />
          </div>
        }
        navBar={<TopNav sections={sections} />}
        topBar={
          <>
            {/* No search box in the masthead: every page that has something
                to search already has its own field, and a second one competed
                with them. The command palette is still one Cmd/Ctrl+K away. */}
            <div className="flex items-center gap-0.5 rounded-full bg-ink-foreground/10 p-1 ring-1 ring-ink-foreground/15">
              {/* Desktop lives in `topBar`; `topBarActions` above is the MOBILE
                  header only, so a control placed there alone is invisible to
                  everyone on a laptop. */}
              <PageRefresh />
              <NotificationBell />
              <HelpAssistant />
              <SoundToggle />
              <LanguageToggle />
            </div>
            <span className="hidden items-center gap-2 rounded-full bg-ink-foreground/10 py-1 pe-1 ps-1 ring-1 ring-ink-foreground/15 sm:flex">
              <Avatar name={displayName} email={user?.email} size="sm" />
              <span className="hidden max-w-[8rem] truncate text-xs font-semibold text-foreground min-[1600px]:inline">
                {displayName}
              </span>
              {/* Sign out lived in the rail footer, which desktop no longer
                  renders — without this there is no way out on desktop. */}
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
        resizeStorageKey="yiji.agent.sidebarWidth"
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
      <NewMessageSound />
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
            path="/"
            element={
              <ProtectedRoute>
                <Shell>
                  <Inbox />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/tickets"
            element={
              <ProtectedRoute>
                <Shell>
                  <TicketsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          {/* Top-level, not /tickets/new: it is its own nav entry, and nested
              under /tickets both items would light up at once. */}
          <Route
            path="/compensation-requests"
            element={
              <ProtectedRoute>
                <Shell>
                  <CompensationPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/performance"
            element={
              <ProtectedRoute>
                <Shell>
                  <AgentPerformancePage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/new-ticket"
            element={
              <ProtectedRoute>
                <Shell>
                  <NewTicketPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/tickets/:ticketId"
            element={
              <ProtectedRoute>
                <Shell>
                  <TicketsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/preferences"
            element={
              <ProtectedRoute>
                <Shell>
                  <PreferencesPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/contacts"
            element={
              <ProtectedRoute>
                <Shell>
                  <ContactsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/contacts/:id"
            element={
              <ProtectedRoute>
                <Shell>
                  <ContactProfilePage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/compensation"
            element={
              <ProtectedRoute>
                <Shell>
                  <MyCouponsPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/compensation-requests/:id"
            element={
              <ProtectedRoute>
                <Shell>
                  <CompensationPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
