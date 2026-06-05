import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  useNotifications,
  useMarkNotificationRead,
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from '../src/features/notifications/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('notifications api — query hooks', () => {
  it('useNotifications fetches recent notifications', async () => {
    request.mockResolvedValueOnce([{ id: 'n1', title: 'Hi' }]);
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useNotificationPreferences fills a default for every type', async () => {
    request.mockResolvedValueOnce({ notification_preferences: { assignment: 'email' } });
    const { result } = renderHook(() => useNotificationPreferences(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const prefs = result.current.data as Record<string, string>;
    // The explicitly-set value is preserved.
    expect(prefs.assignment).toBe('email');
    // Every known type has a value (default 'both' when unset).
    expect(Object.values(prefs).every((v) => typeof v === 'string')).toBe(true);
    expect(Object.values(prefs)).toContain('both');
  });

  it('useNotificationPreferences defaults to both when prefs are null', async () => {
    request.mockResolvedValueOnce({ notification_preferences: null });
    const { result } = renderHook(() => useNotificationPreferences(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const prefs = result.current.data as Record<string, string>;
    expect(Object.values(prefs).every((v) => v === 'both')).toBe(true);
  });
});

describe('notifications api — mutation hooks', () => {
  it('useMarkNotificationRead patches read_at and resolves', async () => {
    request.mockResolvedValueOnce({ id: 'n1' });
    const { result } = renderHook(() => useMarkNotificationRead(), { wrapper: wrapper() });
    await result.current.mutateAsync('n1');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useUpdateNotificationPreferences updates the current user and resolves', async () => {
    request.mockResolvedValueOnce({});
    const { result } = renderHook(() => useUpdateNotificationPreferences(), { wrapper: wrapper() });
    await result.current.mutateAsync({ assignment: 'email' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
