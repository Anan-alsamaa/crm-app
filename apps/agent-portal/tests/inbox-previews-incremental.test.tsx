import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import { markPreviewDirty, useConversationPreviews } from '../src/features/inbox/api.js';

/**
 * ONLY WHAT CHANGED IS READ (owner, 2026-10-11: Directus at 100% CPU).
 * Every message fired inbox:activity to every agent, and each re-read the
 * preview of EVERY listed chat: 18,305 requests in 6 hours, half of Directus's
 * work. Now only a new chat, a moved last_message_at, or a named chat is read.
 */
/** The conversation ids a real `readItems('messages', ...)` request filtered on. */
function idsIn(q: unknown): string[] {
  const o = (typeof q === 'function' ? (q as () => unknown)() : q) as
    | { params?: { filter?: unknown } }
    | undefined;
  const f = o?.params?.filter;
  const filter = (typeof f === 'string' ? JSON.parse(f) : f) as
    | { conversation?: { _in?: string[] } }
    | undefined;
  return filter?.conversation?._in ?? [];
}
const idsAsked = () => request.mock.calls.map((c) => idsIn(c[0]));

beforeEach(() => request.mockReset());

describe('inbox previews are read incrementally', () => {
  it('reads all at first, then only the chat whose last message moved', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    request.mockImplementation(async (q: unknown) =>
      idsIn(q).map((id) => ({
        conversation: id,
        content: `last in ${id}`,
        sender_type: 'customer',
        deleted_at: null,
      })),
    );
    let rows = [
      { id: 'c1', last_message_at: 't1' },
      { id: 'c2', last_message_at: 't1' },
      { id: 'c3', last_message_at: 't1' },
    ];
    const { result, rerender } = renderHook(() => useConversationPreviews(rows), { wrapper });
    await waitFor(() => expect(Object.keys(result.current.data ?? {})).toHaveLength(3));
    expect(idsAsked().flat().sort()).toEqual(['c1', 'c2', 'c3']);

    // A new message in c2 only.
    request.mockClear();
    rows = [rows[0]!, { id: 'c2', last_message_at: 't2' }, rows[2]!];
    rerender();
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(idsAsked().flat()).toEqual(['c2']);
    // The other rows keep their previews.
    await waitFor(() => expect(result.current.data?.c1?.content).toBe('last in c1'));

    // An event naming c3 (e.g. a deleted message) re-reads c3 alone.
    request.mockClear();
    markPreviewDirty(qc, 'c3');
    await qc.invalidateQueries({ queryKey: ['conversation-previews'] });
    expect(idsAsked().flat()).toEqual(['c3']);

    // Nothing changed: no request at all.
    request.mockClear();
    await qc.invalidateQueries({ queryKey: ['conversation-previews'] });
    expect(request).not.toHaveBeenCalled();
  });
});
