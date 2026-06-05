import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  useUsers,
  useRoles,
  useCreateUser,
  defaultNotificationPreferences,
} from '../src/features/users/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('users api', () => {
  it('defaultNotificationPreferences maps every type to "both"', () => {
    const prefs = defaultNotificationPreferences();
    expect(Object.keys(prefs).length).toBeGreaterThan(0);
    for (const v of Object.values(prefs)) expect(v).toBe('both');
  });

  it('useUsers fetches users', async () => {
    request.mockResolvedValueOnce([{ id: 'u1', email: 'a@b.com' }]);
    const { result } = renderHook(() => useUsers(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 'u1', email: 'a@b.com' }]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useRoles fetches roles', async () => {
    request.mockResolvedValueOnce([{ id: 'r1', name: 'Admin' }]);
    const { result } = renderHook(() => useRoles(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('useCreateUser posts with defaults and null team', async () => {
    request.mockResolvedValueOnce({ id: 'u9' });
    const { result } = renderHook(() => useCreateUser(), { wrapper: wrapper() });
    await result.current.mutateAsync({
      email: 'x@y.com',
      password: 'pw',
      role: 'r1',
      team: '',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
