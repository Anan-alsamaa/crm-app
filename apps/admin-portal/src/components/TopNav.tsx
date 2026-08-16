import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDownIcon, cn } from '@yiji/ui';
import type { NavSection } from '../nav.js';

/*
 * Horizontal primary nav for the admin console — text pills in the floating
 * top bar (the owner's reference dashboards: rounded pills on a dark bar,
 * no icon per pill; icons live in the dropdown panels where there is room).
 *
 * The agent portal's entries fit one flat row; the admin console's
 * fourteen do not, so the rail's own grouping becomes the bar: each multi-item
 * section collapses to one menu button, and each single-item section stays a
 * direct link. Fourteen destinations become six top-level controls, and the
 * information architecture is unchanged — no entry is dropped, and nothing
 * hides behind a generic "More".
 *
 * Menus follow the WAI-ARIA menu-button pattern: the trigger owns
 * aria-haspopup/aria-expanded, Enter/Space/ArrowDown open and focus the first
 * item, arrows and Home/End move focus, Escape closes and restores focus to the
 * trigger, and Tab or an outside click dismisses.
 */

/*
 * Icon tiles use the `--<hue>-tint` fills, not a low alpha of the accent, which
 * reads grey over white (DESIGN.md, "Tint ramp"). `--warning` is excluded on
 * purpose: it is a deliberately light token, so `text-warning` on
 * `bg-warning-tint` measures 2.09:1, under the 3:1 WCAG 1.4.11 asks of a
 * non-text glyph. The hues below measure 3.74 / 5.28 / 3.78 / 3.84:1.
 *
 * The four areas an operations lead works in daily carry a hue; the two that
 * are rarely-touched setup (Policies, Intelligence) stay neutral, which is the
 * same ranking the rail's section order already encoded.
 */
const GROUP_TILES: Record<string, string> = {
  '/dashboard': 'bg-sky-tint text-sky',
  '/sla-reports': 'bg-violet-tint text-violet',
  '/users': 'bg-success-tint text-success',
  '/brands': 'bg-primary-tint text-primary',
};
const NEUTRAL_TILE = 'bg-secondary text-muted-foreground';

/** A route is current when it matches exactly or is a parent path segment. */
function matches(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

function tileFor(section: NavSection): string {
  return GROUP_TILES[section.items[0].to] ?? NEUTRAL_TILE;
}

/* Tabs, not pills: the nav now owns its own row in the masthead, so the
 * active destination is marked by a jade underline sitting on the header's
 * bottom edge — the way a masthead marks a section — instead of a filled
 * lozenge that competed with every button on the page. */
/* The reference marks the current section with a solid DARK pill and leaves
 * everything else as quiet text on the canvas — high contrast where you are,
 * nothing where you are not. */
const TRIGGER_BASE =
  'group relative flex h-10 items-center gap-1.5 rounded-full px-4 text-sm whitespace-nowrap transition-[background-color,color,box-shadow] duration-base ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-safe:active:scale-[0.97]';
/* The selected pill is a jade wash with a hairline of the same hue — the glow
 * treatment from the reference boards — rather than a solid fill, which on the
 * floating dark bar read as a button, not a location. */
const TRIGGER_ACTIVE =
  'bg-display font-semibold text-background shadow-[0_8px_20px_-8px_oklch(var(--display)/0.55)]';
const TRIGGER_IDLE = 'font-medium text-foreground/70 hover:bg-card/70 hover:text-foreground';

/** A section with one item: a plain link, no menu. */
function DirectLink({ section }: { section: NavSection }) {
  const item = section.items[0];
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) => cn(TRIGGER_BASE, isActive ? TRIGGER_ACTIVE : TRIGGER_IDLE)}
    >
      <span className="truncate">{item.label}</span>
    </NavLink>
  );
}

/** A section with several items: a menu button plus its dropdown. */
function MenuGroup({ section }: { section: NavSection }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const active = section.items.some((it) => matches(pathname, it.to));
  const tile = tileFor(section);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Dismiss on an outside pointer press. Keydown is handled per-element so the
  // menu never swallows keys meant for the rest of the page.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const focusItem = useCallback((index: number) => {
    const items = itemRefs.current.filter(Boolean);
    if (!items.length) return;
    const wrapped = (index + items.length) % items.length;
    items[wrapped]?.focus();
  }, []);

  // Focus can only move into the panel once it has mounted, so opening records
  // where to land and this effect does it on the next commit.
  const pendingFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!open || pendingFocus.current === null) return;
    const index = pendingFocus.current;
    pendingFocus.current = null;
    focusItem(index);
  }, [open, focusItem]);

  const openAndFocus = (index: number) => {
    if (open) {
      focusItem(index);
      return;
    }
    pendingFocus.current = index;
    setOpen(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAndFocus(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openAndFocus(-1);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close(true);
    }
  };

  const onItemKeyDown = (e: React.KeyboardEvent, index: number) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusItem(0);
        break;
      case 'End':
        e.preventDefault();
        focusItem(-1);
        break;
      case 'Escape':
        e.preventDefault();
        close(true);
        break;
      case 'Tab':
        // Let focus leave naturally, but do not leave an orphaned open menu.
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
        className={cn(TRIGGER_BASE, active ? TRIGGER_ACTIVE : TRIGGER_IDLE)}
      >
        <span className="truncate">{section.heading}</span>
        <ChevronDownIcon
          size={14}
          className={cn(
            'shrink-0 transition-transform duration-fast ease-out',
            open && 'rotate-180',
            active ? 'text-background/70' : 'text-muted-foreground',
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={section.heading}
          className={cn(
            'absolute top-full start-0 z-50 mt-1 min-w-[16rem] rounded-2xl p-1.5',
            'bg-popover/95 text-popover-foreground shadow-xl shadow-black/30 ring-1 ring-border backdrop-blur',
            'origin-top motion-safe:animate-scale-in',
          )}
        >
          {section.items.map((it, i) => (
            <NavLink
              key={it.to}
              to={it.to}
              role="menuitem"
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              onClick={() => close(false)}
              onKeyDown={(e) => onItemKeyDown(e, i)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm',
                  'transition-colors duration-fast ease-out',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  isActive
                    ? 'bg-primary-subtle font-semibold text-foreground'
                    : 'font-medium text-foreground hover:bg-secondary',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      'grid h-6 w-6 shrink-0 place-items-center rounded-md',
                      isActive ? 'bg-primary text-primary-foreground' : tile,
                    )}
                  >
                    <it.icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-start">{it.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopNav({ sections }: { sections: NavSection[] }) {
  return (
    // No overflow scroll here: a scroll container would clip the absolutely
    // positioned dropdown panels. If the row is ever too tight the pills
    // truncate; below lg the drawer takes over anyway.
    <ul className="flex min-w-0 items-center gap-1">
      {sections.map((section, i) => {
        // Divider before the rarely-touched setup groups, so the bar keeps the
        // "daily work / occasional setup" split the rail headings gave it.
        const startsSetup = section.items.length === 1 && sections[i - 1]?.items.length !== 1;
        return (
          <li key={section.heading ?? section.items[0].to} className="flex items-center">
            {i > 0 && startsSetup && (
              <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-border" />
            )}
            {section.items.length === 1 ? (
              <DirectLink section={section} />
            ) : (
              <MenuGroup section={section} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
