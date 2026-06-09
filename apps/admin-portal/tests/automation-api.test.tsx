import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  useAutomationRules,
  useCreateRule,
  useUpdateRule,
  useDeleteRule,
} from '../src/features/automation/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('automation api', () => {
  it('useAutomationRules fetches rules', async () => {
    request.mockResolvedValueOnce([{ id: 'a1', name: 'Auto-assign' }]);
    const { result } = renderHook(() => useAutomationRules(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('useCreateRule posts a rule', async () => {
    request.mockResolvedValueOnce({ id: 'a9' });
    const { result } = renderHook(() => useCreateRule(), { wrapper: wrapper() });
    await result.current.mutateAsync({
      name: 'Rule',
      description: null,
      trigger_event: 'conversation_created',
      conditions: null,
      actions: null,
      active: true,
      priority: 1,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useUpdateRule patches a rule', async () => {
    request.mockResolvedValueOnce({ id: 'a1' });
    const { result } = renderHook(() => useUpdateRule(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 'a1', patch: { active: false } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useDeleteRule deletes a rule', async () => {
    request.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDeleteRule(), { wrapper: wrapper() });
    await result.current.mutateAsync('a1');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
