import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { RefreshButton } from '@yiji/ui';

describe('RefreshButton', () => {
  it('runs the refresh and marks itself busy while it does', async () => {
    let release: () => void = () => {};
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const user = userEvent.setup();
    render(<RefreshButton onRefresh={onRefresh} label="Refresh this page" />);

    const btn = screen.getByRole('button', { name: 'Refresh this page' });
    await user.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(btn).toHaveAttribute('aria-busy', 'true');

    release();
    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'false'), { timeout: 2000 });
  });

  it('ignores a second press while the first is still running', async () => {
    const onRefresh = vi.fn(() => new Promise<void>(() => {})); // never settles
    const user = userEvent.setup();
    render(<RefreshButton onRefresh={onRefresh} label="Refresh this page" />);

    const btn = screen.getByRole('button', { name: 'Refresh this page' });
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    // Pressing again during a refresh is the same request, not three of them.
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

  it('recovers when the refresh throws, instead of spinning forever', async () => {
    const onRefresh = vi.fn(() => Promise.reject(new Error('offline')));
    const user = userEvent.setup();
    render(<RefreshButton onRefresh={onRefresh} label="Refresh" />);
    const btn = screen.getByRole('button', { name: 'Refresh' });

    await user.click(btn);
    // A failed refresh is the case somebody presses this button FOR, so the
    // button has to come back and let them try again.
    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'false'), { timeout: 2000 });
  });
});
