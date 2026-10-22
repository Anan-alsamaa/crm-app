import type { JSX } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '@yiji/ui';
import { useAuth } from '../lib/auth/AuthContext.js';
import type { Privilege } from '../lib/privileges.js';

export interface ReportTab {
  to: string;
  label: string;
  /**
   * The privilege this report needs.
   *
   * The top nav filters its own destinations, but this strip is a SECOND set of
   * them one level down — and it was rendering all of them. An operations role
   * that could reach Ticket breakdown was shown Compensation sitting beside it.
   */
  requires?: Privilege;
}

/**
 * The second level of navigation: a strip of report tabs directly under the
 * masthead, with the chosen report rendered beneath it.
 *
 * This replaces a dropdown that listed all seven reports under two headings.
 * That put every destination one click away, which sounds like an advantage
 * and is not: the menu had to be opened and read in full before any of it
 * could be dismissed, and the two headings inside it were the only thing
 * saying which half you were in. Here the top nav names the SET you are in and
 * this strip names the report — you can see where you are without opening
 * anything.
 *
 * A layout route, so switching tabs re-renders only what is below the strip
 * and the strip itself never remounts.
 */
export function ReportGroupTabs({ tabs }: { tabs: ReportTab[] }): JSX.Element {
  const { can } = useAuth();
  const visible = tabs.filter((tab) => !tab.requires || can(tab.requires));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav
        aria-label="Report"
        hidden={visible.length < 2}
        // Sticky and hairlined: it belongs to the masthead above it, not to
        // the report below, and scrolling a long table must not take the
        // reader's place in the section away with it.
        /* `hidden` as a CLASS too: the attribute alone loses to `flex`, which
           left a lone, single-report group showing its one chip. */
        className={cn(
          'shrink-0 items-center gap-1.5 overflow-x-auto px-5 pb-1 pt-3 sm:px-7',
          visible.length < 2 ? 'hidden' : 'flex',
        )}
      >
        {visible.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end
            className={({ isActive }) =>
              cn(
                /* Rapport filter chips: the current report a solid ink chip,
                   the rest frosted white chips with a hairline. */
                'shrink-0 rounded-full px-4 py-2 text-sm font-semibold whitespace-nowrap',
                'transition-[background-color,color,box-shadow] duration-fast ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
                isActive
                  ? 'bg-ink text-ink-foreground'
                  : 'bg-white/60 text-foreground/80 ring-1 ring-inset ring-white/80 hover:bg-white/90 hover:text-foreground',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      {/* min-h-0 so a report that owns its own scroll can actually scroll —
          without it the flex child grows to its content and the page scrolls
          instead, taking the tab strip off screen. */}
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
