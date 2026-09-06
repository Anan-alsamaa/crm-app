import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { PageRefresh } from '../src/components/PageRefresh.js';

function wrap(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <PageRefresh />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.restoreAllMocks());

describe('the masthead Refresh button', () => {
  it('re-fetches the data instead of reloading the document', async () => {
    /*
     * THE POINT. It used to call location.reload(), which threw away the
     * masthead, the route and every open drawer to deliver numbers the page
     * could have fetched in place.
     */
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });

    wrap(qc);
    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(reload, 'the document was reloaded').not.toHaveBeenCalled();
  });

  it('refetches only what is on screen', async () => {
    // Refetching inactive queries too would spend the wait on data for pages
    // nobody is looking at.
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();

    wrap(qc);
    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidate).toHaveBeenCalledWith({ refetchType: 'active' });
  });

  it('stays busy until the new data has landed', async () => {
    // Resolving early would flash "done" over stale numbers.
    const qc = new QueryClient();
    let settle: (() => void) | undefined;
    vi.spyOn(qc, 'invalidateQueries').mockReturnValue(
      new Promise<void>((res) => {
        settle = res;
      }),
    );

    wrap(qc);
    const btn = screen.getByRole('button');
    await userEvent.click(btn);

    // aria-busy, not `disabled`: a disabled control loses focus and stops
    // announcing itself, dropping a keyboard user mid-action.
    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'true'));
    settle?.();
    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'false'));
  });
});
