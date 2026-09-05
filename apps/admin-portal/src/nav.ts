import type { UsersIcon } from '@yiji/ui';
import type { Privilege } from './lib/privileges.js';

/*
 * Nav shapes shared by the two presentations of the same tree: the horizontal
 * TopNav on desktop and the Rail inside the mobile drawer. Kept out of App.tsx
 * so TopNav can import them without a cycle.
 */

export interface NavItem {
  to: string;
  label: string;
  icon: typeof UsersIcon;
  hint?: string;
  /**
   * A heading this item sits under INSIDE its section's menu — the third
   * level, so a destination can be reached as Reports → Operational KPI →
   * Tickets.
   *
   * Items carry their group rather than the section holding a list of groups
   * because everything else — the active check, the rail, the hue — walks a
   * flat `items` array, and nesting the data would mean teaching all of that
   * about a shape only the dropdown cares about. Consecutive items sharing a
   * group render under one heading; an item with none simply has no heading
   * above it.
   */
  group?: string;
  /**
   * The privilege this destination needs, if any.
   *
   * Items whose privilege the signed-in role lacks are removed before the nav
   * renders — a section left with no items disappears with them. Hiding is not
   * securing: the same privilege gates the ROUTE (see ProtectedRoute), so a
   * bookmark cannot walk in behind the menu, and Directus decides what any of
   * it can actually read.
   */
  requires?: Privilege;
  /**
   * Owner-only entry: shown to the project owner (Directus admin_access) and
   * nobody else. Not a privilege — no role edit can widen it.
   */
  ownerOnly?: boolean;
}

export interface NavSection {
  heading?: string;
  /**
   * Non-empty by construction. The lead item is meaningful, not incidental: it
   * supplies the group's hue and the icon on its menu trigger, and a section
   * with no destinations would render an empty button. A tuple states that
   * invariant once instead of forcing an undefined check at every use.
   */
  items: [NavItem, ...NavItem[]];
}
