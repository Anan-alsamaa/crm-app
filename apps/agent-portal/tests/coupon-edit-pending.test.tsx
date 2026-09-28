import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * A PENDING REQUEST CAN BE CORRECTED. A DECIDED ONE CANNOT.
 *
 * Agents had no way to fix a mistyped value — the request reached the
 * supervisor exactly as entered, and the only remedies were to have it rejected
 * or to let a wrong coupon through (owner, 2026-09-28).
 *
 * THE LOCK IS SERVER-SIDE, not a hidden button. `status: pending` is part of
 * the UPDATE's own filter, so a request decided in the seconds between the form
 * opening and Save being pressed matches nothing and changes nothing. Hiding a
 * control is not a lock: what the supervisor approved must not move under them.
 *
 * And an update that matches nothing must SAY so. Directus answers an empty
 * array rather than an error, which would otherwise read as a saved edit —
 * this codebase's recurring failure shape.
 */

const sdk = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request: sdk.request } }));

const captured = vi.hoisted(() => ({ filter: null as unknown, patch: null as unknown }));
vi.mock('@directus/sdk', () => ({
  createItem: (collection: string, data: unknown) => ({ kind: 'create', collection, data }),
  readItems: (collection: string, query: unknown) => ({ kind: 'read', collection, query }),
  updateItems: (collection: string, filter: unknown, patch: unknown) => {
    captured.filter = filter;
    captured.patch = patch;
    return { kind: 'update', collection, filter, patch };
  },
}));

import { useUpdatePendingCouponRequest } from '../src/features/coupons/api.js';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  sdk.request.mockReset();
  captured.filter = null;
  captured.patch = null;
});

describe('Correcting a pending compensation request', () => {
  it('saves the corrected values', async () => {
    sdk.request.mockResolvedValueOnce([{ id: 'c1' }]);
    const { result } = renderHook(() => useUpdatePendingCouponRequest(), { wrapper: wrapper() });

    await result.current.mutateAsync({ id: 'c1', patch: { coupon_value: 25 } });

    expect(sdk.request).toHaveBeenCalledTimes(1);
    expect(captured.patch).toEqual({ coupon_value: 25 });
  });

  /*
   * THE LOCK. The status is in the FILTER, so the database decides — not the
   * button's visibility.
   */
  it('filters on pending, so a decided request cannot be matched', async () => {
    sdk.request.mockResolvedValueOnce([{ id: 'c1' }]);
    const { result } = renderHook(() => useUpdatePendingCouponRequest(), { wrapper: wrapper() });

    await result.current.mutateAsync({ id: 'c1', patch: { title: 'x' } });

    expect(captured.filter).toEqual({ id: { _eq: 'c1' }, status: { _eq: 'pending' } });
  });

  /*
   * THE DANGEROUS CASE: approved while the form was open. Directus returns an
   * empty array, NOT an error — so without this the agent is told their
   * correction saved when nothing changed at all.
   */
  it('REFUSES loudly when the request was decided meanwhile', async () => {
    sdk.request.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useUpdatePendingCouponRequest(), { wrapper: wrapper() });

    await expect(
      result.current.mutateAsync({ id: 'c1', patch: { coupon_value: 25 } }),
    ).rejects.toThrow(/already been decided/i);
  });

  it('treats a non-array answer as a failure too', async () => {
    sdk.request.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useUpdatePendingCouponRequest(), { wrapper: wrapper() });

    await expect(result.current.mutateAsync({ id: 'c1', patch: { title: 'x' } })).rejects.toThrow(
      /already been decided/i,
    );
  });

  /*
   * The customer, the order, the status and the decision are what the request
   * IS — a correction that could change them would be a different request
   * wearing the same id. The patch type names what may move; this asserts the
   * hook forwards nothing else on its own.
   */
  it('sends only the fields it was given', async () => {
    sdk.request.mockResolvedValueOnce([{ id: 'c1' }]);
    const { result } = renderHook(() => useUpdatePendingCouponRequest(), { wrapper: wrapper() });

    await result.current.mutateAsync({ id: 'c1', patch: { reason: 'corrected wording' } });

    expect(Object.keys(captured.patch as object)).toEqual(['reason']);
  });

  it('refreshes both queues, so the admin list is not left stale', async () => {
    sdk.request.mockResolvedValueOnce([{ id: 'c1' }]);
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdatePendingCouponRequest(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });

    await result.current.mutateAsync({ id: 'c1', patch: { title: 'x' } });

    await waitFor(() => {
      const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(keys.some((k) => k.includes('my-coupon-requests'))).toBe(true);
      expect(keys.some((k) => k.includes('all-compensation'))).toBe(true);
    });
  });
});
