import type { ReactNode } from 'react';
import { AppShell, useIsDesktop, type AppShellRailContext } from '@yiji/ui';

/*
 * THE ADMIN SHELL (Rapport skin, owner 2026-10-22).
 *
 * Desktop: no masthead slab. The brand sits on the page at the start, the
 * destinations are CENTRED as pill tabs on a dark nav bar, and the round
 * utility buttons (language, refresh, AI, notifications) and the account sit
 * at the end. The owner dropped the side rail (2026-10-22): it repeated the
 * top bar.
 *
 * Mobile (< lg): unchanged. The shared AppShell already does the drawer, the
 * focus and scroll locking and the Escape handling; rendering it below the
 * breakpoint keeps all of that rather than re-implementing it.
 *
 * Owned by this portal on purpose. AppShell is shared with the agent portal,
 * and its desktop branch stays exactly as the agent portal knows it.
 */

export interface AdminShellProps {
  /** The centred pill navigation (TopNav). */
  nav: ReactNode;
  /** The round utility buttons and account chip at the end of the header. */
  utilities: ReactNode;
  /** Language toggle - first of the round utility buttons. */
  language: ReactNode;
  /** The vertical nav for the mobile drawer. */
  mobileRail: (ctx: AppShellRailContext) => ReactNode;
  mobileBrand: ReactNode;
  mobileActions: ReactNode;
  navLabel: string;
  menuLabel: string;
  closeLabel: string;
  children: ReactNode;
}

export function AdminShell({
  nav,
  utilities,
  language,
  mobileRail,
  mobileBrand,
  mobileActions,
  navLabel,
  menuLabel,
  closeLabel,
  children,
}: AdminShellProps) {
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
            className="col-start-1 row-start-1 flex min-w-0 items-center justify-center rounded-full bg-gradient-to-b from-ink to-rail-deep p-1.5 shadow-[0_24px_48px_-24px_oklch(var(--shadow-color)/0.6)]"
          >
            {nav}
          </nav>
          <div
            data-env-slot=""
            className="col-start-1 row-start-1 -translate-y-[30px] empty:hidden"
          />
        </div>
        <div className="admin-utilities flex shrink-0 items-center gap-2">
          {language}
          {utilities}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
