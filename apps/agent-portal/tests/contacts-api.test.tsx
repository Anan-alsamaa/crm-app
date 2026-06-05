import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

// Mock the shared authenticated Directus client; queryFn/mutationFn resolve
// against canned data — no network. `request` is hoisted so it exists before
// the hoisted vi.mock factory runs.
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  useContacts,
  useContact,
  useContactConversations,
  useContactTickets,
  useDeleteContact,
} from '../src/features/contacts/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('contacts api — query hooks', () => {
  it('useContacts fetches the contacts collection', async () => {
    request.mockResolvedValueOnce([{ id: 'k1', name: 'Alice' }]);
    const { result } = renderHook(() => useContacts(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 'k1', name: 'Alice' }]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useContact stays disabled with an empty id', () => {
    const { result } = renderHook(() => useContact(''), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(request).not.toHaveBeenCalled();
  });

  it('useContact fetches a single contact when given an id', async () => {
    request.mockResolvedValueOnce({ id: 'k1', name: 'Alice' });
    const { result } = renderHook(() => useContact('k1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ id: 'k1' });
  });

  it('useContactConversations is disabled without a contactId', () => {
    const { result } = renderHook(() => useContactConversations(''), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(request).not.toHaveBeenCalled();
  });

  it('useContactConversations fetches when given a contactId', async () => {
    request.mockResolvedValueOnce([{ id: 'c1', status: 'open' }]);
    const { result } = renderHook(() => useContactConversations('k1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('useContactTickets fetches when given a contactId', async () => {
    request.mockResolvedValueOnce([{ id: 't1', subject: 'Help' }]);
    const { result } = renderHook(() => useContactTickets('k1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });
});

describe('contacts api — mutation hooks', () => {
  it('useDeleteContact deletes and resolves', async () => {
    request.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDeleteContact(), { wrapper: wrapper() });
    await result.current.mutateAsync('k1');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
