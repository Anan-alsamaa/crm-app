import type { UsersIcon } from '@yiji/ui';

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
