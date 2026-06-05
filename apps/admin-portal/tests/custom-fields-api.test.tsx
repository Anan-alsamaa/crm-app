import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  useCustomFields,
  useCreateField,
  useUpdateField,
  useDeleteField,
} from '../src/features/custom-fields/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('custom-fields api', () => {
  it('useCustomFields fetches fields', async () => {
    request.mockResolvedValueOnce([{ id: 'f1', name: 'Tier' }]);
    const { result } = renderHook(() => useCustomFields(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('useCreateField posts a field', async () => {
    request.mockResolvedValueOnce({ id: 'f9' });
    const { result } = renderHook(() => useCreateField(), { wrapper: wrapper() });
    await result.current.mutateAsync({
      entity_type: 'contact',
      name: 'Tier',
      key: 'tier',
      field_type: 'text',
      options: null,
      required: false,
      display_order: 1,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useUpdateField patches a field', async () => {
    request.mockResolvedValueOnce({ id: 'f1' });
    const { result } = renderHook(() => useUpdateField(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 'f1', patch: { required: true } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useDeleteField deletes a field', async () => {
    request.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDeleteField(), { wrapper: wrapper() });
    await result.current.mutateAsync('f1');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
