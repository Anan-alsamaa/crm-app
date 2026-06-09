import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  useReports,
  useCreateReport,
  useUpdateReport,
  useDeleteReport,
} from '../src/features/reports/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('reports api', () => {
  it('useReports fetches reports', async () => {
    request.mockResolvedValueOnce([{ id: 'r1', name: 'Volume' }]);
    const { result } = renderHook(() => useReports(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('useCreateReport posts a report', async () => {
    request.mockResolvedValueOnce({ id: 'r9' });
    const { result } = renderHook(() => useCreateReport(), { wrapper: wrapper() });
    await result.current.mutateAsync({
      name: 'New',
      description: null,
      type: 'conversation_volume',
      filters: null,
      schedule: null,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useUpdateReport patches a report', async () => {
    request.mockResolvedValueOnce({ id: 'r1' });
    const { result } = renderHook(() => useUpdateReport(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 'r1', patch: { name: 'Renamed' } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useDeleteReport deletes a report', async () => {
    request.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDeleteReport(), { wrapper: wrapper() });
    await result.current.mutateAsync('r1');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
