import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { ChartIcon, ClockIcon, ShieldIcon, UsersIcon } from '@yiji/ui';

import { TopNav } from '../src/components/TopNav.js';
import type { NavSection } from '../src/nav.js';

/* One single-item section, one multi-item section, one more single — enough to
 * cover both presentations and the divider between them. */
const SECTIONS: NavSection[] = [
  { heading: 'Overview', items: [{ to: '/dashboard', label: 'Dashboard', icon: ChartIcon }] },
  {
    heading: 'Reports',
    items: [
      { to: '/sla-reports', label: 'SLA performance', icon: ClockIcon },
      { to: '/report-tickets', label: 'Tickets', icon: UsersIcon },
    ],
  },
  { heading: 'Policies', items: [{ to: '/sla', label: 'SLA', icon: ShieldIcon }] },
];

function renderNav(initialPath = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TopNav sections={SECTIONS} />
    </MemoryRouter>,
  );
}

beforeEach(() => cleanup());

describe('TopNav (admin, grouped)', () => {
  it('collapses 4 destinations into 3 top-level controls', () => {
    renderNav();
    // Single-item sections are direct links; the multi-item one is a button.
    expect(screen.getByRole('link', { name: /Dashboard/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^SLA$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reports/ })).toBeInTheDocument();
    // Menu children are not in the DOM until the menu opens.
    expect(screen.queryByText('SLA performance')).toBeNull();
  });

  it('opens on click and exposes the menu-button ARIA contract', async () => {
    const user = userEvent.setup();
    renderNav();
    const trigger = screen.getByRole('button', { name: /Reports/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Reports' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
  });

  it('ArrowDown opens the menu and focuses the first item', async () => {
    const user = userEvent.setup();
    renderNav();
    const trigger = screen.getByRole('button', { name: /Reports/ });
    trigger.focus();
    await user.keyboard('{ArrowDown}');

    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    // Wraps back to the top.
    await user.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
  });

  it('Escape closes the menu and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    renderNav();
    const trigger = screen.getByRole('button', { name: /Reports/ });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('marks the group active when a child route is current', () => {
    renderNav('/report-tickets');
    const trigger = screen.getByRole('button', { name: /Reports/ });
    // The filled pill is how selection reads; a side stripe is banned. The
    // fill is the ink token (AURA LIGHT), not the accent.
    expect(trigger.className).toContain('bg-display');
    expect(screen.getByRole('link', { name: /Dashboard/ }).className).not.toContain('bg-display');
  });

  it('does not confuse sibling prefixes: /sla-reports must not activate /sla', () => {
    renderNav('/sla-reports');
    // The Policies link points at /sla, which is a string prefix of the current
    // path — matching on startsWith alone would light it up incorrectly.
    expect(screen.getByRole('link', { name: /^SLA$/ }).className).not.toContain('bg-display');
    expect(screen.getByRole('button', { name: /Reports/ }).className).toContain('bg-display');
  });

  it('selecting a menu item closes the menu', async () => {
    const user = userEvent.setup();
    renderNav();
    await user.click(screen.getByRole('button', { name: /Reports/ }));
    await user.click(screen.getAllByRole('menuitem')[0]!);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
