import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  useVendors,
  useCreateVendor,
  useUpdateVendor,
  useDeleteVendor,
} from '../src/features/vendors/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('vendors api', () => {
  it('useVendors fetches vendors', async () => {
    request.mockResolvedValueOnce([{ id: 'v1', name: 'Acme' }]);
    const { result } = renderHook(() => useVendors(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('useCreateVendor posts a vendor', async () => {
    request.mockResolvedValueOnce({ id: 'v9' });
    const { result } = renderHook(() => useCreateVendor(), { wrapper: wrapper() });
    await result.current.mutateAsync({
      name: 'New',
      yiji_vendor_id: 'y1',
      colors: null,
      status: 'active',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useUpdateVendor patches a vendor', async () => {
    request.mockResolvedValueOnce({ id: 'v1' });
    const { result } = renderHook(() => useUpdateVendor(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 'v1', patch: { status: 'inactive' } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useDeleteVendor deletes a vendor', async () => {
    request.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDeleteVendor(), { wrapper: wrapper() });
    await result.current.mutateAsync('v1');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
