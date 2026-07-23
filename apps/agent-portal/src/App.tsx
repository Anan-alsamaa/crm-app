import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
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
import { NotificationBell } from './features/notifications/NotificationBell.js';
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
            <div className="flex items-baseline gap-1.5 text-[15px] font-semibold tracking-[-0.015em] text-rail-active-foreground">
              <span>Yiji</span>
              <span className="text-rail-foreground/70 font-normal">CRM</span>
            </div>
            <div className="text-2xs text-rail-foreground/75 mt-0.5">
              {t('app.workspace', { defaultValue: 'Agent workspace' })}
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
              {sec.items.map((it) => (
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
                        isCollapsed ? 'justify-center px-0' : 'gap-3 px-2.5',
                      )
                    }
                  >
                    <it.icon size={16} />
                    {!isCollapsed && <span className="flex-1 truncate">{it.label}</span>}
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

/** Compact brand lockup for the mobile top bar. */
function MobileBrand() {
  return (
    <div className="flex items-center gap-2">
      <YijiLogo variant="tile" size={28} className="bg-rail shadow-sm shrink-0" />
      <span className="text-[15px] font-semibold tracking-[-0.015em] text-foreground">
        Yiji <span className="font-normal text-muted-foreground">CRM</span>
      </span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  // Command-palette open state is lifted here so the top-bar search trigger and
  // the Cmd/Ctrl+K shortcut both drive the one palette instance below.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sections: NavSection[] = [
    {
      heading: t('nav.work', { defaultValue: 'Work' }),
      items: [
        { to: '/', end: true, label: t('nav.inbox'), icon: InboxIcon },
        { to: '/tickets', label: t('nav.tickets'), icon: TicketIcon },
        {
          to: '/contacts',
          label: t('nav.contacts', { defaultValue: 'Contacts' }),
          icon: UsersIcon,
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
  // Current section label — anchors the left of the top bar so it reads as a
  // real top bar (context left, actions right) instead of icons floating in a
  // empty band.
  const pageTitle =
    sections
      .flatMap((s) => s.items)
      .find((it) =>
        it.to === '/' ? location.pathname === '/' : location.pathname.startsWith(it.to),
      )?.label ?? '';
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
            <SoundToggle />
            <LanguageToggle />
          </div>
        }
        topBar={
          <div className="flex w-full items-center gap-3">
            {/* Left: section label */}
            <div className="flex min-w-0 flex-1 items-center">
              <span className="hidden truncate text-sm font-semibold tracking-tight text-foreground md:block">
                {pageTitle}
              </span>
            </div>
            {/* Center: the search field */}
            <div className="flex w-full max-w-md justify-center">
              <SearchTrigger
                fullWidth
                label={t('actions.searchPlaceholder', { ns: 'common', defaultValue: 'Search…' })}
                aria-label={t('actions.search', { ns: 'common', defaultValue: 'Search' })}
                onClick={() => setPaletteOpen(true)}
              />
            </div>
            {/* Right: utility controls */}
            <div className="flex flex-1 items-center justify-end gap-1 text-muted-foreground">
              <NotificationBell />
              <SoundToggle />
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              <LanguageToggle />
            </div>
          </div>
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
