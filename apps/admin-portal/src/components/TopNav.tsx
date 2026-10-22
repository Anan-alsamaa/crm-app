import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
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
  '/reports/agent-kpi': 'bg-violet-tint text-violet',
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

/* RAPPORT PILL TABS (owner, 2026-10-22). The current section is a solid DARK
 * pill - the ink, on the brand hue - and everything else is plain text on the
 * page: high contrast where you are, nothing where you are not. 13.5px/600,
 * 10px x 17px, fully rounded, exactly the reference's tab. */
const TRIGGER_BASE =
  'group relative flex h-10 min-w-0 items-center gap-1.5 rounded-full px-3 text-[0.84375rem] 2xl:px-[17px] font-semibold ' +
  'transition-[background-color,color,box-shadow] duration-fast ease-out ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'motion-safe:active:scale-[0.97]';
const TRIGGER_ACTIVE =
  'bg-ink text-ink-foreground shadow-[0_10px_24px_-14px_oklch(var(--ink)/0.9)]';
const TRIGGER_IDLE = 'text-foreground/80 hover:bg-white/60 hover:text-foreground';

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

  /* A section that links to its FIRST tab (Agent KPI -> Agent summary) is
     still current on every other tab of it (owner, 2026-10-15: the highlight
     vanished on Compensation). */
  const sectionHere = (it: NavSection['items'][number]) =>
    !!it.activeOn && matches(pathname, it.activeOn);
  const active = section.items.some((it) => matches(pathname, it.to) || sectionHere(it));
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
            active ? 'text-ink-foreground/70' : 'text-muted-foreground',
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={section.heading}
          className={cn(
            'absolute top-full start-0 z-50 mt-2 min-w-[16rem] rounded-[1.25rem] p-1.5',
            'bg-popover text-popover-foreground ring-1 ring-foreground/[0.06]',
            'shadow-[0_2px_6px_oklch(var(--shadow-color)/0.06),0_30px_60px_-28px_oklch(var(--shadow-color)/0.45)]',
            'origin-top motion-safe:animate-scale-in',
          )}
        >
          {section.items.map((it, i) => (
            <Fragment key={it.to}>
              {/* The third level: a heading whenever the group changes, so
                  Reports reads as two named sets rather than one long list.
                  Compared against the PREVIOUS item, so consecutive entries
                  sharing a group print their heading once. */}
              {it.group && it.group !== section.items[i - 1]?.group && (
                <div
                  className={cn(
                    'px-2 pb-1 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground',
                    i > 0 && 'mt-2 border-t border-border pt-2.5',
                  )}
                >
                  {it.group}
                </div>
              )}
              <NavLink
                to={it.to}
                role="menuitem"
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                onClick={() => close(false)}
                onKeyDown={(e) => onItemKeyDown(e, i)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded-xl px-2 py-2 text-sm',
                    'transition-colors duration-fast ease-out',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    isActive || sectionHere(it)
                      ? 'bg-ink/[0.06] font-semibold text-foreground'
                      : 'font-medium text-foreground hover:bg-secondary',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={cn(
                        'grid h-7 w-7 shrink-0 place-items-center rounded-full',
                        isActive || sectionHere(it) ? 'bg-ink text-ink-foreground' : tile,
                      )}
                    >
                      <it.icon size={14} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-start">{it.label}</span>
                  </>
                )}
              </NavLink>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopNav({ sections }: { sections: NavSection[] }) {
  return (
    // No overflow scroll here: a scroll container would clip the absolutely
    // positioned dropdown panels. When the row is too tight the pills TRUNCATE
    // instead — which needs `min-w-0` all the way down, or a flex child refuses
    // to shrink below its content and the row silently slides underneath the
    // utilities at the end of the masthead instead of compressing.
    <ul className="flex min-w-0 items-center gap-0.5">
      {sections.map((section, i) => {
        // Divider before the rarely-touched setup groups, so the bar keeps the
        // "daily work / occasional setup" split the rail headings gave it.
        const startsSetup = section.items.length === 1 && sections[i - 1]?.items.length !== 1;
        return (
          <li key={section.heading ?? section.items[0].to} className="flex min-w-0 items-center">
            {i > 0 && startsSetup && (
              <span aria-hidden className="mx-1.5 h-5 w-px shrink-0 bg-foreground/10" />
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
