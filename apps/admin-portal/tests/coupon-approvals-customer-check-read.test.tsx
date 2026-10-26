import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * THE STORED "HAS A YIJI ACCOUNT" ANSWER (incident 2026-10-26).
 *
 * The queue reads `yiji_customer_found` - written by the workers - instead of
 * asking Yiji per card. The field needs a manual `apply:fields`, and naming a
 * missing field 403s the WHOLE Directus read, so the queue must fall back to
 * reading without it rather than going empty. And it must never touch the
 * commerce client (Yiji) at all.
 */

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string, opts: unknown) => ({ collection, opts }),
  updateItem: (collection: string, id: string, payload: unknown) => ({ collection, id, payload }),
}));
vi.mock('../src/lib/job-producer.js', () => ({
  jobProducer: { enqueueCouponPush: vi.fn(async () => ({ ok: true })) },
}));
const commerceCalls = vi.hoisted(() => [] as string[]);
vi.mock('../src/lib/commerce-client.js', () => ({
  commerce: new Proxy(
    {},
    {
      get: (_t, key) =>
        typeof key === 'symbol' || key === 'then'
          ? undefined
          : () => {
              commerceCalls.push(String(key));
              return Promise.resolve(null);
            },
    },
  ),
}));

import { useCouponApprovals } from '../src/features/coupon-approvals/api.js';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

type Q = { collection: string; opts: { fields: unknown[] } };
const fieldsOf = (q: unknown) => (q as Q).opts.fields;

beforeEach(() => {
  request.mockReset();
  commerceCalls.length = 0;
});

describe('useCouponApprovals - the stored customer check', () => {
  it('reads yiji_customer_found / yiji_customer_checked_at with the queue', async () => {
    request.mockResolvedValue([{ id: 'ca1', status: 'pending', yiji_customer_found: false }]);
    const { result } = renderHook(() => useCouponApprovals('pending'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(request).toHaveBeenCalledTimes(1);
    expect(fieldsOf(request.mock.calls[0]![0])).toEqual(
      expect.arrayContaining(['yiji_customer_found', 'yiji_customer_checked_at']),
    );
    expect(result.current.data![0]!.yiji_customer_found).toBe(false);
    expect(commerceCalls).toEqual([]);
  });

  it('falls back to reading WITHOUT them when Directus refuses (field not applied)', async () => {
    request
      .mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }))
      .mockResolvedValueOnce([{ id: 'ca1', status: 'pending' }]);
    const { result } = renderHook(() => useCouponApprovals('pending'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(request).toHaveBeenCalledTimes(2);
    const second = fieldsOf(request.mock.calls[1]![0]);
    expect(second).not.toContain('yiji_customer_found');
    expect(second).not.toContain('yiji_customer_checked_at');
    expect(second).toContain('delivery_excluded');
    expect(result.current.data).toEqual([{ id: 'ca1', status: 'pending' }]);
    expect(commerceCalls).toEqual([]);
  });
});
