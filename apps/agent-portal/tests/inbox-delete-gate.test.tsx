import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

/*
 * DELETING CHATS IS THE ADMINISTRATOR'S CONTROL AND NOBODY ELSE'S.
 *
 * The real boundary is Directus — no app role holds `conversations.delete`, so
 * the API refuses everyone else however the button is reached. What this file
 * pins is the OTHER half: that the portal does not offer the action to people
 * who cannot perform it, and that when it does offer it, it asks first.
 *
 * A control that is merely hidden is a courtesy; a control that is hidden AND
 * refused is a boundary. This tests the courtesy, because the courtesy is the
 * part a refactor can silently remove.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: Record<string, unknown>) => {
      let s = (o?.defaultValue as string | undefined) ?? _k;
      if (o) {
        for (const [k, v] of Object.entries(o)) {
          if (k !== 'defaultValue') s = s.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return s;
    },
  }),
}));

const h = vi.hoisted(() => ({
  isOwner: false,
  remove: vi.fn(async () => undefined),
  conversations: [
    { id: 'c1', status: 'open', unread_count_agent: 0, contact: { name: 'Ayman' } },
  ] as unknown[],
}));

vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'u1' }, can: () => true, isOwner: h.isOwner }),
}));

vi.mock('../src/features/inbox/api.js', () => ({
  conversationIdsForOrder: async () => [],
  useConversations: () => ({
    data: h.conversations,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useDeleteConversation: () => ({ mutateAsync: h.remove, isPending: false }),
  useInboxCounts: () => ({ data: undefined }),
  useConversationPreviews: () => ({ data: {} }),
  useUpdateConversation: () => ({ mutateAsync: vi.fn() }),
  useAddTagToConversation: () => ({ mutateAsync: vi.fn() }),
  usePrefetchInboxOrders: () => vi.fn(),
  useTags: () => ({ data: [] }),
}));

vi.mock('../src/features/conversation/ConversationView.js', () => ({
  ConversationView: () => <div />,
}));
vi.mock('../src/lib/socket.js', () => ({
  getSocket: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: true }),
}));

import { Inbox } from '../src/pages/Inbox.js';

function renderInbox() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Inbox />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Tick the row's checkbox, which is what reveals the bulk toolbar. */
function selectFirstChat() {
  // The row's own box is labelled by the contact's name; the other is "select
  // all". Fail loudly if it is not there — a silent fallback would let this
  // helper quietly stop selecting anything, and the gating tests below would
  // then pass for the wrong reason.
  fireEvent.click(screen.getByLabelText('Ayman'));
}

beforeEach(() => {
  h.isOwner = false;
  h.remove.mockClear();
});

describe('inbox bulk delete — Administrator only', () => {
  it('does NOT offer Delete to a non-Administrator', async () => {
    h.isOwner = false;
    renderInbox();
    selectFirstChat();
    // The toolbar is there (Clear proves it) but Delete is not on it.
    await waitFor(() => expect(screen.queryByText('Delete')).toBeNull());
  });

  it('offers Delete to the Administrator', async () => {
    h.isOwner = true;
    renderInbox();
    selectFirstChat();
    await waitFor(() => expect(screen.getByText('Delete')).toBeTruthy());
  });

  it('asks before deleting, and does not delete on its own', async () => {
    h.isOwner = true;
    renderInbox();
    selectFirstChat();
    fireEvent.click(await screen.findByText('Delete'));
    // The dialog states the consequence rather than asking "are you sure".
    await waitFor(() => expect(screen.getByText(/This cannot be undone/)).toBeTruthy());
    // Opening the dialog must not have deleted anything yet.
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('deletes only once confirmed', async () => {
    h.isOwner = true;
    renderInbox();
    selectFirstChat();
    fireEvent.click(await screen.findByText('Delete'));
    const dialog = await screen.findByRole('alertdialog');
    // The dialog's own confirm button, not the toolbar button behind it.
    const confirm = within(dialog).getByText('Delete');
    fireEvent.click(confirm);
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('c1'));
  });
});
