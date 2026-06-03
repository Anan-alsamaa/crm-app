import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  ClockIcon,
  cn,
  SettingsIcon,
  SignOutIcon,
  TeamIcon,
  Toaster,
  useResizable,
  UsersIcon,
  YijiLogo,
} from '@yiji/ui';
import { AuthProvider, useAuth } from './lib/auth/AuthContext.js';
import { ProtectedRoute } from './lib/auth/ProtectedRoute.js';
import { Login } from './pages/Login.js';
import { UsersPage } from './features/users/UsersPage.js';
import { TeamsPage } from './features/teams/TeamsPage.js';
import { SlaPoliciesPage } from './features/sla/SlaPoliciesPage.js';
import { VendorsPage } from './features/vendors/VendorsPage.js';
import { AiConfigPage } from './features/ai-config/AiConfigPage.js';
import { LanguageToggle } from './components/LanguageToggle.js';
import { AppCommandPalette } from './components/AppCommandPalette.js';

interface NavItem {
  to: string;
  label: string;
  icon: typeof UsersIcon;
  hint?: string;
}

interface NavSection {
  heading?: string;
  items: NavItem[];
}

function Sidebar({ sections }: { sections: NavSection[] }) {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || '';
  const { width, dragging, bind } = useResizable({
    storageKey: 'yiji.admin.sidebarWidth',
    defaultWidth: 224,
    min: 64,
    max: 360,
  });
  const isCollapsed = width < 140;

  return (
    <nav
      aria-label="Primary navigation"
      style={{ width }}
      className={cn(
        'relative z-30 flex shrink-0 flex-col my-3 ms-3 rounded-xl bg-rail text-rail-foreground shadow-lg shadow-rail/20',
        !dragging && 'transition-[width] duration-150 ease-out',
      )}
    >
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
              <span className="text-rail-foreground/45 font-normal">CRM</span>
            </div>
            <div className="text-2xs text-rail-foreground/55 mt-0.5">Admin console</div>
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
              <h3 className="mb-1 px-2 text-2xs font-semibold uppercase tracking-[0.12em] text-rail-foreground/45 whitespace-nowrap">
                {sec.heading}
              </h3>
            )}
            <ul className="space-y-0.5">
              {sec.items.map((it) => (
                <li key={it.to}>
                  <NavLink
                    to={it.to}
                    title={it.label}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex h-9 items-center rounded-md text-sm font-medium',
                        'transition-[background-color,color] duration-fast ease-out',
                        'hover:bg-rail-active hover:text-rail-active-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                        isActive
                          ? 'bg-rail-active text-rail-active-foreground'
                          : 'text-rail-foreground/85',
                        isCollapsed ? 'justify-center px-0' : 'gap-3 px-2.5',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <span
                            aria-hidden
                            className="absolute start-0 inset-y-2 w-0.5 rounded-full bg-primary"
                          />
                        )}
                        <it.icon size={16} />
                        {!isCollapsed && (
                          <span className="flex-1 truncate">{it.label}</span>
                        )}
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

      {/* Drag handle — 6px hit area on the trailing edge */}
      <div
        {...bind}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className={cn(
          'group/handle absolute inset-y-0 end-0 w-1.5 -me-0.5 cursor-col-resize',
          'flex items-center justify-center',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'h-12 w-0.5 rounded-full transition-colors duration-fast ease-out',
            dragging
              ? 'bg-primary'
              : 'bg-transparent group-hover/handle:bg-primary/40',
          )}
        />
      </div>
    </nav>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const sections: NavSection[] = [
    {
      heading: t('nav.workspace', { defaultValue: 'Workspace' }),
      items: [
        { to: '/users', label: t('nav.users'), icon: UsersIcon },
        { to: '/teams', label: t('nav.teams'), icon: TeamIcon },
        { to: '/vendors', label: t('nav.vendors', { defaultValue: 'Vendors' }), icon: TeamIcon },
      ],
    },
    {
      heading: t('nav.policies', { defaultValue: 'Policies' }),
      items: [{ to: '/sla', label: t('nav.sla'), icon: ClockIcon }],
    },
    {
      heading: t('nav.intelligence', { defaultValue: 'Intelligence' }),
      items: [{ to: '/ai-config', label: t('nav.aiConfig', { defaultValue: 'AI assistance' }), icon: SettingsIcon }],
    },
  ];
  return (
    <div className="flex h-full text-foreground">
      <Sidebar sections={sections} />
      <main className="flex-1 min-w-0 min-h-0 m-3 ms-3 rounded-2xl bg-card/85 shadow-xl shadow-foreground/5 ring-1 ring-foreground/[0.04] overflow-hidden">
        {children}
      </main>
      <AppCommandPalette />
      <Toaster position="bottom" />
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
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
            path="/ai-config"
            element={
              <ProtectedRoute>
                <Shell>
                  <AiConfigPage />
                </Shell>
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<Navigate to="/users" replace />} />
          <Route path="*" element={<Navigate to="/users" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
