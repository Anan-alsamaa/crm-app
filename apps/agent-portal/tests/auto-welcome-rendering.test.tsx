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
import { canOfferMessageActions } from '../src/features/conversation/message-edits.js';
import en from '../src/i18n/en.json';
import ar from '../src/i18n/ar.json';

/**
 * THE AUTOMATIC WELCOME IN THE AGENT PORTAL (owner, 2026-10-06).
 *
 * The gateway sends operations' "رسالة ترحيب" template after the customer's
 * first message as an agent-style message with NO `sender_user`. Agents see it
 * as an agent bubble, but it is not theirs: no "You", no "You:" in the inbox,
 * no Edit/Delete, and its own run so a real reply is never merged under it.
 */
function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}
const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

beforeEach(() => request.mockReset());

describe('inbox preview', () => {
  it('flags the welcome as automated, and a person’s reply not', async () => {
    request.mockResolvedValueOnce([
      { conversation: 'c1', content: 'Welcome', sender_type: 'agent', sender_user: null },
      { conversation: 'c2', content: 'On it', sender_type: 'agent', sender_user: 'agent-7' },
    ]);
    const { result } = renderHook(() => useConversationPreviews(['c1', 'c2']), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.c1).toMatchObject({ automated: true });
    expect(result.current.data?.c2?.automated).toBeUndefined();
  });

  /* Unselected, every reply would read as automated: the field must be asked for. */
  it('selects sender_user', () => {
    expect(read('src/features/inbox/api.ts')).toContain(
      "fields: ['conversation', 'content', 'sender_type', 'sender_user', 'deleted_at']",
    );
  });

  it('drops the "You:" prefix for it', () => {
    expect(read('src/pages/Inbox.tsx')).toContain(
      "return pv.sender_type === 'agent' && !pv.automated",
    );
  });
});

describe('the thread', () => {
  const VIEW = read('src/features/conversation/ConversationView.tsx');

  it('labels it "Automatic welcome" instead of "You"', () => {
    expect(VIEW).toContain('const isAutoWelcome = isAutomatedAgentMessage(head);');
    expect(VIEW).toContain("t('conversation.autoWelcome'");
    expect(en.conversation.autoWelcome).toBe('Automatic welcome');
    expect(ar.conversation.autoWelcome).toMatch(/[؀-ۿ]/);
  });

  it('keeps it in its own run', () => {
    expect(VIEW).toContain('isAutomatedAgentMessage(last[0]!) === isAutomatedAgentMessage(m)');
  });

  it('never offers Edit/Delete on it', () => {
    expect(
      canOfferMessageActions(
        {
          id: 'w',
          sender_type: 'agent',
          sender_user: null,
          content: 'Welcome',
          is_internal_note: false,
          date_created: new Date().toISOString(),
        },
        'agent-7',
        Date.now(),
      ),
    ).toBe(false);
  });
});
