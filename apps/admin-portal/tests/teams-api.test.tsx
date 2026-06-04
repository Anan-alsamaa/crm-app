import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import { useTeams, useCreateTeam } from '../src/features/teams/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('teams api', () => {
  it('useTeams fetches teams', async () => {
    request.mockResolvedValueOnce([{ id: 't1', name: 'Sales', description: null }]);
    const { result } = renderHook(() => useTeams(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useCreateTeam posts a new team', async () => {
    request.mockResolvedValueOnce({ id: 't9' });
    const { result } = renderHook(() => useCreateTeam(), { wrapper: wrapper() });
    await result.current.mutateAsync({ name: 'Support', description: 'desc' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
