import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

// The hooks read/write through the shared authenticated Directus client.
// Mock it so queryFn/mutationFn resolve against canned data — no network.
// `request` is hoisted so it exists before the hoisted vi.mock factory runs.
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import {
  useConversations,
  useMessages,
  useConversation,
  useUpdateConversation,
  useLinkedTickets,
  useAgents,
  useTeamOptions,
  useTags,
  useAddTagToConversation,
  useCreateTag,
  conversationIdsForOrder,
} from '../src/features/inbox/api.js';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('inbox api — query hooks', () => {
  it('useConversations fetches with the default (recent) sort', async () => {
    request.mockResolvedValueOnce([{ id: 'c1', status: 'open' }]);
    const { result } = renderHook(() => useConversations(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 'c1', status: 'open' }]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useConversations applies status/priority/search filters', async () => {
    request.mockResolvedValueOnce([]);
    const { result } = renderHook(
      () =>
        useConversations({ status: 'open', priority: 'high', search: 'alice', sort: 'priority' }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(request).toHaveBeenCalled();
  });

  it('useMessages stays disabled without a conversation id', () => {
    const { result } = renderHook(() => useMessages(null), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(request).not.toHaveBeenCalled();
  });

  it('useMessages fetches when given an id', async () => {
    request.mockResolvedValueOnce([{ id: 'm1', content: 'hi' }]);
    const { result } = renderHook(() => useMessages('c1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('useConversation returns the first row or null', async () => {
    request.mockResolvedValueOnce([{ id: 'c1', status: 'open' }]);
    const { result } = renderHook(() => useConversation('c1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ id: 'c1' });
  });

  it('useLinkedTickets / useAgents / useTeamOptions / useTags fetch their collections', async () => {
    request.mockResolvedValue([{ id: 'x' }]);
    for (const hook of [useLinkedTickets, useAgents, useTeamOptions, useTags]) {
      const { result } = renderHook(
        () => (hook === useLinkedTickets ? useLinkedTickets('c1') : (hook as () => unknown)()),
        { wrapper: wrapper() },
      );
      await waitFor(() => expect((result.current as { isSuccess: boolean }).isSuccess).toBe(true));
    }
  });
});

describe('inbox api — mutation hooks', () => {
  it('useUpdateConversation patches and resolves', async () => {
    request.mockResolvedValueOnce({ id: 'c1' });
    const { result } = renderHook(() => useUpdateConversation(), { wrapper: wrapper() });
    await result.current.mutateAsync({ id: 'c1', patch: { status: 'solved' } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useAddTagToConversation creates the junction row', async () => {
    request.mockResolvedValueOnce({ id: 'j1' });
    const { result } = renderHook(() => useAddTagToConversation(), { wrapper: wrapper() });
    await result.current.mutateAsync({ conversationId: 'c1', tagId: 't1' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('useCreateTag creates a tag with a default color', async () => {
    request.mockResolvedValueOnce({ id: 't9' });
    const { result } = renderHook(() => useCreateTag(), { wrapper: wrapper() });
    await result.current.mutateAsync({ name: 'VIP' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

/**
 * Order-id search. The order lives on the TICKET, not the conversation, and
 * Directus cannot filter inside the json snapshot at all, so the id is
 * duplicated into an indexed `order_id` column and looked up separately.
 */
describe('conversationIdsForOrder', () => {
  it('queries tickets by order id and returns their conversations', async () => {
    request.mockResolvedValueOnce([{ conversation: 'c1' }, { conversation: 'c2' }]);
    await expect(conversationIdsForOrder('946641')).resolves.toEqual(['c1', 'c2']);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates when several tickets share one conversation', async () => {
    // Otherwise the id repeats inside the `_in` filter for no benefit.
    request.mockResolvedValueOnce([
      { conversation: 'c1' },
      { conversation: 'c1' },
      { conversation: 'c3' },
    ]);
    await expect(conversationIdsForOrder('1095')).resolves.toEqual(['c1', 'c3']);
  });

  it('drops tickets that have no conversation', async () => {
    // Most tickets are raised standalone; they match the order but there is no
    // chat to open, so returning null would put a dead row in the filter.
    request.mockResolvedValueOnce([{ conversation: null }, { conversation: 'c2' }]);
    await expect(conversationIdsForOrder('946641')).resolves.toEqual(['c2']);
  });

  it('does not query at all for a term with no digits', async () => {
    // Every keystroke of a customer name would otherwise hit the tickets
    // collection for something that cannot be an order id.
    await expect(conversationIdsForOrder('maria')).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('ignores surrounding whitespace', async () => {
    request.mockResolvedValueOnce([{ conversation: 'c9' }]);
    await expect(conversationIdsForOrder('  946641  ')).resolves.toEqual(['c9']);
  });
});
