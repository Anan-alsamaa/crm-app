import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AppShell,
  SearchIcon,
  TicketIcon,
  cn,
  useIsDesktop,
  type AppShellRailContext,
} from '@yiji/ui';
import type { NavItem, NavSection } from '../../nav.js';

/*
 * THE ADMIN SHELL (Rapport skin, owner 2026-10-22).
 *
 * Desktop: no masthead slab. The brand sits on the page at the start, the
 * destinations are CENTRED as pill tabs, round utility buttons and the
 * account sit at the end - and a slim dark rail floats at the start edge with
 * the quick actions. The rail is a real column, not an overlay, so it can
 * never sit on top of a table.
 *
 * Mobile (< lg): unchanged. The shared AppShell already does the drawer, the
 * focus and scroll locking and the Escape handling; rendering it below the
 * breakpoint keeps all of that rather than re-implementing it.
 *
 * Owned by this portal on purpose. AppShell is shared with the agent portal,
 * and its desktop branch stays exactly as the agent portal knows it.
 */

/**
 * Destinations offered as one-click quick actions in the rail, in order - the
 * pages an operations lead opens daily. Each appears only when this role's
 * nav already holds it, so the rail can never offer a page the role cannot
 * open. `icon` overrides the nav's glyph where the nav's is generic.
 */
const QUICK_LINKS: Array<{ to: string; icon?: NavItem['icon'] }> = [
  { to: '/coupon-approvals' },
  { to: '/reports/operational-kpi', icon: TicketIcon },
  { to: '/agent-performance' },
  { to: '/users' },
];

export interface AdminShellProps {
  sections: NavSection[];
  /** The centred pill navigation (TopNav). */
  nav: ReactNode;
  /** The round utility buttons and account chip at the end of the header. */
  utilities: ReactNode;
  /** Language toggle - lives in the rail on wide screens, the header otherwise. */
  language: ReactNode;
  /** Opens the command palette (the rail's search button). */
  onSearch: () => void;
  /** The vertical nav for the mobile drawer. */
  mobileRail: (ctx: AppShellRailContext) => ReactNode;
  mobileBrand: ReactNode;
  mobileActions: ReactNode;
  navLabel: string;
  menuLabel: string;
  closeLabel: string;
  children: ReactNode;
}

/** The rail's quick links: the ones this role can actually reach. */
function quickLinks(sections: NavSection[]): NavItem[] {
  const all = sections.flatMap((s) => s.items);
  return QUICK_LINKS.flatMap(({ to, icon }) => {
    const hit = all.find((it) => it.to === to || it.activeOn === to || it.to.startsWith(`${to}/`));
    return hit ? [{ ...hit, icon: icon ?? hit.icon }] : [];
  });
}

const RAIL_BTN =
  'grid h-10 w-10 place-items-center rounded-full text-ink-foreground/70 ' +
  'transition-[background-color,color,transform] duration-fast ease-out ' +
  'hover:bg-ink-foreground/[0.12] hover:text-ink-foreground motion-safe:active:scale-[0.94] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70';

export function AdminShell({
  sections,
  nav,
  utilities,
  language,
  onSearch,
  mobileRail,
  mobileBrand,
  mobileActions,
  navLabel,
  menuLabel,
  closeLabel,
  children,
}: AdminShellProps) {
  const { t } = useTranslation();
  const isDesktop = useIsDesktop();

  if (!isDesktop) {
    return (
      <div className="admin-skin h-full">
        <AppShell
          rail={mobileRail}
          topBarBrand={mobileBrand}
          topBarActions={mobileActions}
          resizeStorageKey="yiji.admin.sidebarWidth"
          navLabel={navLabel}
          menuLabel={menuLabel}
          closeLabel={closeLabel}
        >
          {children}
        </AppShell>
      </div>
    );
  }

  const quick = quickLinks(sections);
  const searchLabel = t('shell.search', { defaultValue: 'Search (Ctrl+K)' });

  return (
    <div className="admin-skin flex h-full flex-col text-foreground">
      <header
        /* The environment badge finds this bar by name and renders INSIDE it
           (see EnvironmentBanner), in the slot stacked over the nav. */
        data-app-topbar=""
        className="relative z-30 flex h-20 shrink-0 items-center gap-4 px-5 xl:px-8"
      >
        <div className="flex shrink-0 items-center gap-2.5">
          {/* The artwork's corners are already cut; no rounding on the img. */}
          <img src="/sara-crm-icon.svg" alt="Sara CRM" className="h-10 w-10 shrink-0" />
          <span
            aria-hidden
            className="hidden text-[1.0625rem] font-bold tracking-[-0.01em] text-foreground 2xl:inline"
          >
            Sara CRM
          </span>
        </div>
        {/* The nav stays centred; the environment badge sits ABOVE it in the
            same grid cell, so it never shunts the pills sideways. */}
        {/* `minmax(0,1fr)` so the column may shrink below the pills' natural
            width - otherwise a tight screen centres an overflowing row and it
            slides under the brand instead of truncating. */}
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] place-items-center">
          <nav
            aria-label={navLabel}
            className="col-start-1 row-start-1 flex min-w-0 items-center justify-center"
          >
            {nav}
          </nav>
          <div
            data-env-slot=""
            className="col-start-1 row-start-1 -translate-y-[30px] empty:hidden"
          />
        </div>
        <div className="admin-utilities flex shrink-0 items-center gap-2">
          {/* Language lives in the rail where the rail exists (xl+). */}
          <span className="xl:hidden">{language}</span>
          {utilities}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* THE RAIL: quick actions, wide screens only. A column of its own, so
            content starts after it rather than under it. */}
        <aside
          aria-label={t('shell.quickActions', { defaultValue: 'Quick actions' })}
          className="hidden shrink-0 items-center ps-5 xl:flex xl:ps-8"
        >
          <div className="flex w-14 flex-col items-center gap-1.5 rounded-full bg-gradient-to-b from-ink to-rail-deep py-3 text-ink-foreground shadow-[0_24px_48px_-24px_oklch(var(--shadow-color)/0.6)]">
            <button
              type="button"
              onClick={onSearch}
              aria-label={searchLabel}
              title={searchLabel}
              className={RAIL_BTN}
            >
              <SearchIcon size={17} />
            </button>
            {quick.length > 0 && (
              <span aria-hidden className="my-1 h-px w-6 bg-ink-foreground/15" />
            )}
            {quick.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                aria-label={it.label}
                title={it.label}
                className={({ isActive }) =>
                  cn(RAIL_BTN, isActive && 'bg-primary text-primary-foreground hover:bg-primary')
                }
              >
                <it.icon size={17} />
              </NavLink>
            ))}
            <span aria-hidden className="my-1 h-px w-6 bg-ink-foreground/15" />
            {/* The language toggle, re-bound to read on the dark rail. */}
            <span className="admin-rail-language">{language}</span>
          </div>
        </aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
