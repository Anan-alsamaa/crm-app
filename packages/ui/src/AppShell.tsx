import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { cn } from './cn.js';
import { useResizable } from './useResizable.js';
import { useIsDesktop } from './useMediaQuery.js';
import { CloseIcon, MenuIcon } from './Icon.js';

/*
 * AppShell — the responsive frame both portals share.
 *
 * Desktop (>= lg): a resizable side rail (drag handle on the trailing edge,
 * collapses to icons under ~140px) next to the main card. Identical to the
 * hand-rolled rail each portal used to carry.
 *
 * Mobile (< lg): the rail becomes an off-canvas drawer behind a top bar with a
 * hamburger toggle. The drawer slides from the start edge (flips for RTL),
 * locks body scroll, and closes on Esc, backdrop click, or nav activation.
 *
 * `<main>` is rendered in the same position in both branches, so swapping
 * between desktop and mobile chrome never remounts the page content.
 */

export interface AppShellRailContext {
  /** Where the rail is rendered: the desktop side rail or the mobile drawer. */
  variant: 'desktop' | 'mobile';
  /** Desktop rail collapsed to icons (width < 140). Always false in the mobile drawer. */
  collapsed: boolean;
  /** Call when a nav item activates so the mobile drawer closes. No-op on desktop. */
  onNavigate: () => void;
}

export interface AppShellProps {
  /** Rail content (brand + nav + footer), rendered into the desktop rail or mobile drawer. */
  rail: (ctx: AppShellRailContext) => ReactNode;
  /** Compact brand shown in the mobile top bar. */
  topBarBrand?: ReactNode;
  /** Optional trailing actions in the mobile top bar (e.g. a notification bell). */
  topBarActions?: ReactNode;
  /**
   * Optional desktop top navbar, rendered as a slim header above the content
   * card (right-aligned utility controls — notifications, sound, language, …).
   * No-op on mobile, where `topBarActions` already serves that role.
   */
  topBar?: ReactNode;
  /** localStorage key persisting the desktop rail width. */
  resizeStorageKey: string;
  /** Accessible label for the nav landmark. */
  navLabel: string;
  /** Accessible label for the hamburger toggle. */
  menuLabel: string;
  /** Accessible label for the close-drawer button. */
  closeLabel: string;
  children: ReactNode;
}

const RAIL_CLASS =
  'relative z-30 flex shrink-0 flex-col rounded-xl bg-rail text-rail-foreground shadow-lg shadow-rail/20';

export function AppShell({
  rail,
  topBarBrand,
  topBarActions,
  topBar,
  resizeStorageKey,
  navLabel,
  menuLabel,
  closeLabel,
  children,
}: AppShellProps) {
  const isDesktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  const { width, dragging, bind } = useResizable({
    storageKey: resizeStorageKey,
    defaultWidth: 224,
    min: 64,
    max: 360,
  });

  // Lock body scroll + close on Esc while the mobile drawer is open.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const mainCard = (marginClass: string) => (
    <main
      className={cn(
        'flex-1 min-w-0 min-h-0 rounded-2xl bg-card/85 shadow-xl shadow-foreground/5 ring-1 ring-foreground/[0.04] overflow-hidden',
        marginClass,
      )}
    >
      {children}
    </main>
  );

  if (isDesktop) {
    const railNav = (
      <nav
        aria-label={navLabel}
        style={{ width }}
        className={cn(
          RAIL_CLASS,
          'my-3 ms-3',
          !dragging && 'transition-[width] duration-150 ease-out',
        )}
      >
        {rail({ variant: 'desktop', collapsed: width < 140, onNavigate: () => {} })}
        {/* Drag handle — 6px hit area on the trailing edge */}
        <div
          {...bind}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          className="group/handle absolute inset-y-0 end-0 w-1.5 -me-0.5 cursor-col-resize flex items-center justify-center"
        >
          <span
            aria-hidden
            className={cn(
              'h-12 w-0.5 rounded-full transition-colors duration-fast ease-out',
              dragging ? 'bg-primary' : 'bg-transparent group-hover/handle:bg-primary/40',
            )}
          />
        </div>
      </nav>
    );

    // With a top navbar: the content column carries a slim header above the
    // card. Without one: the card fills the column (legacy behaviour).
    if (topBar) {
      return (
        <div className="flex h-full text-foreground">
          {railNav}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Slim top bar — just tall enough for the section label + controls,
                so the content card (and the conversation) gets the height. */}
            <header className="flex h-10 shrink-0 items-center px-3.5 pt-1.5">{topBar}</header>
            {mainCard('mx-3 mb-3 mt-0.5')}
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full text-foreground">
        {railNav}
        {mainCard('m-3 ms-3')}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col text-foreground">
      {/* Mobile top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={menuLabel}
          aria-expanded={open}
          aria-controls="app-mobile-nav"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-foreground transition-colors duration-fast ease-out hover:bg-secondary active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <MenuIcon size={20} />
        </button>
        <div className="min-w-0 flex-1">{topBarBrand}</div>
        {topBarActions}
      </header>

      {mainCard('mx-2 mb-2')}

      {/* Off-canvas drawer + backdrop — always mounted so it can transition;
          `invisible` removes it from the tab order and a11y tree when closed. */}
      <div className={cn('fixed inset-0 z-50', !open && 'pointer-events-none')}>
        <div
          aria-hidden
          onClick={() => setOpen(false)}
          className={cn(
            'absolute inset-0 bg-foreground/30 backdrop-blur-sm transition-opacity duration-medium ease-out',
            open ? 'opacity-100' : 'opacity-0',
          )}
        />
        <nav
          id="app-mobile-nav"
          aria-label={navLabel}
          className={cn(
            RAIL_CLASS,
            'absolute inset-y-0 start-0 w-[17rem] max-w-[85vw] rounded-none rounded-e-2xl',
            'transition-[transform,visibility] duration-slow ease-drawer',
            open ? 'translate-x-0 visible' : 'invisible -translate-x-full rtl:translate-x-full',
          )}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={closeLabel}
            className="absolute end-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md text-rail-foreground/70 transition-colors duration-fast ease-out hover:bg-rail-active hover:text-rail-active-foreground active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <CloseIcon size={18} />
          </button>
          {rail({ variant: 'mobile', collapsed: false, onNavigate: () => setOpen(false) })}
        </nav>
      </div>
    </div>
  );
}
