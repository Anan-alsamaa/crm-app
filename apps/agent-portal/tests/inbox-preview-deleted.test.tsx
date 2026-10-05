import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/directus.js', () => ({ directus: { request } }));

import { useConversationPreviews } from '../src/features/inbox/api.js';

/**
 * A WITHDRAWN LAST REPLY SAYS SO IN THE INBOX (owner, 2026-10-05 (EMA-33)).
 *
 * A deleted reply has empty content, which the preview would otherwise read as
 * an attachment-only message and label "Attachment". It must read "This
 * message was deleted" instead.
 */
function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => request.mockReset());

describe('inbox preview of a deleted last message', () => {
  it('is flagged deleted, not mistaken for an attachment', async () => {
    request.mockResolvedValueOnce([
      { conversation: 'c1', content: '', sender_type: 'agent', deleted_at: '2026-10-05T10:00:00Z' },
      { conversation: 'c2', content: '', sender_type: 'customer', deleted_at: null },
      { conversation: 'c3', content: 'hi', sender_type: 'customer', deleted_at: null },
    ]);
    const { result } = renderHook(() => useConversationPreviews(['c1', 'c2', 'c3']), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.c1).toMatchObject({ deleted: true, hasAttachment: false });
    expect(result.current.data?.c2).toMatchObject({ hasAttachment: true });
    expect(result.current.data?.c2?.deleted).toBeUndefined();
    expect(result.current.data?.c3).toMatchObject({ content: 'hi', hasAttachment: false });
  });

  it('the Inbox renders the placeholder text for it', () => {
    const INBOX = readFileSync(resolve(import.meta.dirname, '../src/pages/Inbox.tsx'), 'utf8');
    expect(INBOX).toMatch(/if \(pv\.deleted\) return t\('inbox\.messageDeleted'/);
  });
});
