import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AddTicketIcon,
  AppShell,
  type AppShellRailContext,
  Avatar,
  ClockIcon,
  cn,
  ErrorBoundary,
  InboxIcon,
  SearchTrigger,
  SettingsIcon,
  SignOutIcon,
  Spinner,
  TicketIcon,
  Toaster,
  UsersIcon,
  YijiLogo,
} from '@yiji/ui';
import { RouteError } from './components/RouteError.js';
import { AuthProvider, useAuth } from './lib/auth/AuthContext.js';
import { ProtectedRoute } from './lib/auth/ProtectedRoute.js';
import { Login } from './pages/Login.js';
import { ResetPassword, RESET_PASSWORD_PATH } from './pages/ResetPassword.js';
import { NotificationBell } from './features/notifications/NotificationBell.js';
import { HelpAssistant } from './features/help-assistant/HelpAssistant.js';
import { LanguageToggle } from './components/LanguageToggle.js';
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
                'flex h-9 items-center rounded-full px-3.5 text-sm whitespace-nowrap',
                'transition-[background-color,color,box-shadow] duration-fast ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                'motion-safe:active:scale-[0.97]',
                isActive
                  ? 'bg-primary/15 font-semibold text-primary ring-1 ring-inset ring-primary/25'
                  : 'font-medium text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
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
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || 'Agent';
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
          to: '/coupons',
          label: t('nav.coupons', { defaultValue: 'My coupons' }),
          icon: TicketIcon,
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
            <SearchTrigger
              label={t('actions.searchPlaceholder', { ns: 'common', defaultValue: 'Search…' })}
              aria-label={t('actions.search', { ns: 'common', defaultValue: 'Search' })}
              onClick={() => setPaletteOpen(true)}
              className="hidden sm:inline-flex"
            />
            <span className="mx-0.5 hidden h-5 w-px bg-border sm:block" aria-hidden />
            <NotificationBell />
            <HelpAssistant />
            <SoundToggle />
            <LanguageToggle />
          </div>
        }
        navBar={<TopNav sections={sections} />}
        topBar={
          <>
            {/* The bar is a card surface now, so the utility triggers read
                correctly with their own tokens — no rebinding needed. The
                search chrome and the user's name yield below 1600px — at
                1440 they crowded the row and clipped the last nav pill; the
                palette stays reachable via Cmd/Ctrl+K regardless. */}
            <SearchTrigger
              label={t('actions.searchPlaceholder', { ns: 'common', defaultValue: 'Search…' })}
              aria-label={t('actions.search', { ns: 'common', defaultValue: 'Search' })}
              onClick={() => setPaletteOpen(true)}
              className="hidden min-[1600px]:inline-flex"
            />
            <div className="flex items-center gap-0.5 rounded-full bg-secondary/50 p-1 ring-1 ring-border">
              <NotificationBell />
              <HelpAssistant />
              <SoundToggle />
              <LanguageToggle />
            </div>
            <span className="hidden items-center gap-2 rounded-full bg-secondary/50 py-1 pe-1 ps-1 ring-1 ring-border sm:flex">
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
            path="/coupons"
            element={
              <ProtectedRoute>
                <Shell>
                  <MyCouponsPage />
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
                  <CompensationPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route
            path="/compensation/:id"
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
