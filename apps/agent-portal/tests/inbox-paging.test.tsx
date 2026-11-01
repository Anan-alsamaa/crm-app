import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));
vi.mock('@directus/sdk', async (orig) => ({
  ...(await orig<typeof import('@directus/sdk')>()),
  readItems: (collection: string, query: unknown) => ({ collection, query }),
}));

import {
  INBOX_PAGE_SIZE,
  useConversations,
  useConversationsTotal,
} from '../src/features/inbox/api.js';

/**
 * THE INBOX READS ONE WINDOW (2026-11-01): it read every conversation - 1,003
 * on prod and growing - plus a preview each, on every refresh. Now it asks for
 * the newest INBOX_PAGE_SIZE, and the header's number is one aggregate.
 */
function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const queries = () =>
  request.mock.calls.map((c) => c[0] as { collection: string; query: Record<string, unknown> });

beforeEach(() => {
  request.mockClear();
  request.mockImplementation(async (arg: { query: { aggregate?: unknown } }) =>
    arg.query.aggregate ? [{ count: { id: '1003' } }] : [],
  );
});

describe('Inbox paging', () => {
  it('asks for one window of conversations, not all of them', async () => {
    renderHook(() => useConversations({ sort: 'recent' }, { page: INBOX_PAGE_SIZE }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(INBOX_PAGE_SIZE).toBe(100);
    expect(queries()[0]!.query.limit).toBe(100);
  });

  it('a bigger window after Load more', async () => {
    renderHook(() => useConversations({}, { page: 200 }), { wrapper: wrapper() });
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(queries()[0]!.query.limit).toBe(200);
  });

  it('the total is one count, never the rows', async () => {
    const { result } = renderHook(() => useConversationsTotal({}), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toBe(1003));
    const q = queries()[0]!.query;
    expect(q.aggregate).toEqual({ count: 'id' });
    expect(q.limit).toBeUndefined();
  });

  it('the command palette preview is still capped and quiet', async () => {
    renderHook(() => useConversations({}, { limit: 8 }), { wrapper: wrapper() });
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(queries()[0]!.query.limit).toBe(8);
  });
});
