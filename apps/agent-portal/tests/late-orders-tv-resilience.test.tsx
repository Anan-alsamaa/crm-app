import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';

/**
 * THE TV SCREEN (owner, 2026-10-11): "Could not load late orders" on the wall.
 * The live queue polls every 10 s with no retry, and the page checked the
 * error BEFORE the data - so one failed refresh replaced a good table with
 * the error screen. Now a refresh is retried and the last table stays up.
 */
const commerce = vi.hoisted(() => ({ getLateOrders: vi.fn() }));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce }));

import { useLateOrders } from '../src/features/late-orders/api.js';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('late orders on a wall screen', () => {
  it('retries a failed load instead of showing the error at once', async () => {
    commerce.getLateOrders
      .mockRejectedValueOnce(new Error('commerce 503'))
      .mockResolvedValueOnce({ rows: [], thresholdMinutes: 60, builtAt: '' });
    const { result } = renderHook(
      () => useLateOrders({ from: '2026-10-11', to: '2026-10-11' }, true, true, undefined, true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 4_000 });
    expect(commerce.getLateOrders).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good table on screen when a refresh fails', () => {
    const page = readFileSync(
      resolve(__dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
      'utf8',
    );
    // The full error screen only when there is NOTHING to show.
    expect(page).toMatch(/\{queue\.isError && !queue\.data \? \(/);
    expect(page).toMatch(/\{queue\.isError && queue\.data && \(/);
    expect(page).toMatch(/lateOrders\.staleNotice/);
  });
});

/* Owner, 2026-10-12 (option 2): the workers poll Yiji once a minute and PUSH a
   change, so today's queue keeps only a slow safety-net poll - live or not,
   never the old 10 s / 30 s. */
describe('late orders poll rate', () => {
  it('keeps only the 2-minute safety net, live or not', () => {
    const api = readFileSync(resolve(__dirname, '../src/features/late-orders/api.ts'), 'utf8');
    expect(api).toMatch(/refetchInterval: history \? false : LATE_ORDERS_SAFETY_POLL_MS,/);
    expect(api).toMatch(/LATE_ORDERS_SAFETY_POLL_MS = 2 \* 60_000;/);
    expect(api).not.toMatch(/10_000 : 30_000/);
  });
});
