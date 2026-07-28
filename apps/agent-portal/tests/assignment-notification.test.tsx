import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * Assignment notifications: assigning a conversation/ticket to a colleague must
 * enqueue an `assignment` notification for them — best-effort, so a producer
 * outage can never fail or roll back the assignment that already persisted.
 */

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({
  directus: { request },
  auth: { getToken: vi.fn(async () => 'agent-token') },
  DIRECTUS_URL: 'http://localhost:8055',
}));

const { notifySpy } = vi.hoisted(() => ({ notifySpy: vi.fn() }));
vi.mock('../src/lib/job-producer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/job-producer.js')>();
  return { ...actual, notifyAssignmentBestEffort: notifySpy };
});

import { useUpdateConversation } from '../src/features/inbox/api.js';
import { useUpdateTicket } from '../src/features/tickets/api.js';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  request.mockReset();
  notifySpy.mockReset();
});

describe('useUpdateConversation — assignment notification', () => {
  it('notifies the new assignee after a successful assignment', async () => {
    request.mockResolvedValueOnce({ id: 'c1' });
    const { result } = renderHook(() => useUpdateConversation(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 'c1', patch: { assigned_agent: 'agent-2' } });
    await waitFor(() => expect(notifySpy).toHaveBeenCalledWith('conversation', 'c1'));
  });

  it('does NOT notify when the conversation is UNassigned (null)', async () => {
    request.mockResolvedValueOnce({ id: 'c1' });
    const { result } = renderHook(() => useUpdateConversation(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 'c1', patch: { assigned_agent: null } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('does NOT notify for an unrelated patch (status/priority only)', async () => {
    request.mockResolvedValueOnce({ id: 'c1' });
    const { result } = renderHook(() => useUpdateConversation(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 'c1', patch: { status: 'closed' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(notifySpy).not.toHaveBeenCalled();
  });
});

describe('useUpdateTicket — assignment notification', () => {
  it('notifies the new assignee after a successful assignment', async () => {
    request.mockResolvedValueOnce({ id: 't1' });
    const { result } = renderHook(() => useUpdateTicket(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 't1', patch: { assigned_agent: 'agent-2' } });
    await waitFor(() => expect(notifySpy).toHaveBeenCalledWith('ticket', 't1'));
  });

  it('does NOT notify on unassignment or on a status-only patch', async () => {
    request.mockResolvedValue({ id: 't1' });
    const { result } = renderHook(() => useUpdateTicket(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 't1', patch: { assigned_agent: null } });
    await result.current.mutateAsync({ id: 't1', patch: { status: 'resolved' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(notifySpy).not.toHaveBeenCalled();
  });
});

describe('job-producer client — request shape + best-effort contract', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs ONLY { entityType, entityId } with the agent bearer token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, enqueued: true, jobId: 'assign-ticket-t1-a2' }),
    });
    const { jobProducer } = await import('../src/lib/job-producer.js');
    await jobProducer.notifyAssignment('ticket', 't1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/jobs/notify-assignment');
    // No recipient/title/body may leave the client — the server derives them.
    expect(JSON.parse(init.body as string)).toEqual({ entityType: 'ticket', entityId: 't1' });
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer agent-token');
  });

  // The hook tests above stub notifyAssignmentBestEffort, so reach for the REAL
  // implementation here — its "never throws" contract is what keeps a producer
  // outage from failing the assignment.
  const realModule = () =>
    vi.importActual<typeof import('../src/lib/job-producer.js')>('../src/lib/job-producer.js');

  it('notifyAssignmentBestEffort swallows a producer outage (never throws)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { notifyAssignmentBestEffort } = await realModule();
    expect(() => notifyAssignmentBestEffort('conversation', 'c1')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('notifyAssignmentBestEffort swallows a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ ok: false, error: 'queue disabled (no Redis)' }),
    });
    const { notifyAssignmentBestEffort } = await realModule();
    expect(() => notifyAssignmentBestEffort('ticket', 't9')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
