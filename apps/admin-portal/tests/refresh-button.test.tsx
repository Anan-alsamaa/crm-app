import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { RefreshButton } from '@yiji/ui';

describe('RefreshButton', () => {
  it('shows the word rather than a glyph, and uses it as the accessible name', () => {
    render(<RefreshButton onRefresh={() => Promise.resolve()} label="Refresh" />);
    // The label is the button's TEXT, so it is both what is read on screen and
    // what a screen reader announces — no aria-label carrying a second name.
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveTextContent('Refresh');
  });

  it('runs the refresh and marks itself busy while it does', async () => {
    const onRefresh = vi.fn(() => new Promise<void>(() => {}));
    const user = userEvent.setup();
    render(<RefreshButton onRefresh={onRefresh} label="Refresh" busyLabel="Refreshing" />);

    const btn = screen.getByRole('button', { name: 'Refresh' });
    await user.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(btn).toHaveAttribute('aria-busy', 'true');
    // Stays busy: a real reload replaces the document, so there is no "done"
    // state to return to — dropping out of busy would only flicker.
    expect(btn).toHaveTextContent('Refreshing');
  });

  it('ignores a second press while the first is still running', async () => {
    const onRefresh = vi.fn(() => new Promise<void>(() => {}));
    const user = userEvent.setup();
    render(<RefreshButton onRefresh={onRefresh} label="Refresh" />);

    const btn = screen.getByRole('button', { name: /refresh/i });
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('stays focusable while busy rather than disabling itself', async () => {
    const user = userEvent.setup();
    render(<RefreshButton onRefresh={() => new Promise<void>(() => {})} label="Refresh" />);
    const btn = screen.getByRole('button', { name: 'Refresh' });
    await user.click(btn);
    // A disabled control loses focus and stops announcing itself, dropping a
    // keyboard user mid-action. `aria-busy` says the same thing without
    // taking the button away.
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  it('comes back when the reload fails to start, instead of sticking busy', async () => {
    const onRefresh = vi.fn(() => Promise.reject(new Error('blocked')));
    const user = userEvent.setup();
    render(<RefreshButton onRefresh={onRefresh} label="Refresh" />);
    const btn = screen.getByRole('button', { name: 'Refresh' });

    await user.click(btn);
    // This is the button people press when things are already broken, so it
    // has to let them press it again.
    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'false'), { timeout: 2000 });
  });
});

/*
 * The PageRefresh test that lived here asserted the button called
 * location.reload(). That was right while the control existed for a WEDGED
 * page, but the ordinary use is "show me the new numbers", and rebuilding the
 * document to answer it threw away the masthead, the route, every open drawer
 * and the scroll position. The replacement contract — invalidate the active
 * queries, stay busy until they settle — is asserted in page-refresh.test.tsx
 * against a real QueryClient.
 */
