import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  useTickets,
  useTicket,
  useTicketEvents,
  useCreateTicket,
  useUpdateTicket,
} from '../src/features/tickets/api.js';

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('tickets api — query hooks', () => {
  it('useTickets fetches the tickets collection', async () => {
    request.mockResolvedValueOnce([{ id: 't1', subject: 'Help' }]);
    const { result } = renderHook(() => useTickets(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useTicket stays disabled with a null id', () => {
    const { result } = renderHook(() => useTicket(null), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(request).not.toHaveBeenCalled();
  });

  it('useTicket returns the first row or null', async () => {
    request.mockResolvedValueOnce([{ id: 't1', subject: 'Help' }]);
    const { result } = renderHook(() => useTicket('t1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ id: 't1' });
  });

  it('useTicket returns null when no rows match', async () => {
    request.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useTicket('missing'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('useTicketEvents is disabled without a ticketId', () => {
    const { result } = renderHook(() => useTicketEvents(null), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(request).not.toHaveBeenCalled();
  });

  it('useTicketEvents fetches when given a ticketId', async () => {
    request.mockResolvedValueOnce([{ id: 'e1', event_type: 'created' }]);
    const { result } = renderHook(() => useTicketEvents('t1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });
});

describe('tickets api — mutation hooks', () => {
  it('useCreateTicket creates a ticket and resolves', async () => {
    request.mockResolvedValueOnce({ id: 't9' });
    const { result } = renderHook(() => useCreateTicket(), { wrapper: wrapper() });
    await result.current.mutateAsync({
      subject: 'Broken',
      priority: 'high',
      contact: 'k1',
      vendor: 'v1',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useUpdateTicket patches a ticket and resolves', async () => {
    request.mockResolvedValueOnce({ id: 't1' });
    const { result } = renderHook(() => useUpdateTicket(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 't1', patch: { status: 'resolved' } });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
