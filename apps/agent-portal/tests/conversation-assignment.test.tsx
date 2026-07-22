import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

// Mirror of conversation-toolbar.test.tsx: same i18n passthrough, socket stub,
// inbox/api mock surface, and CreateTicketDialog marker. This file focuses on
// the agent-assignment control on the toolbar (assigned_agent), which the
// existing toolbar/E2E tests do not cover.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => ({ user: { id: 'agent-1' } }) }));
vi.mock('../src/lib/socket.js', () => ({
  getSocket: vi.fn().mockResolvedValue({ emit: vi.fn(), on: vi.fn() }),
}));

const inbox = vi.hoisted(() => ({
  useAgents: vi.fn(),
  useTeamOptions: vi.fn(),
  useTags: vi.fn(),
  useAddTagToConversation: vi.fn(),
  useUpdateConversation: vi.fn(),
  useLinkedTickets: vi.fn(),
}));
vi.mock('../src/features/inbox/api.js', () => inbox);

// CreateTicketDialog pulls in its own api/auth; stub it to a marker.
vi.mock('../src/features/tickets/CreateTicketDialog.js', () => ({
  CreateTicketDialog: () => <div>create-ticket-dialog</div>,
}));

import { ConversationToolbar } from '../src/features/conversation/ConversationToolbar.js';

const baseConversation = {
  id: 'c1',
  status: 'open' as const,
  priority: 'high' as const,
  last_message_at: null,
  unread_count_agent: 0,
  // typed wide so the reassign test can override with an agent id.
  assigned_agent: null as string | null,
  assigned_team: null,
  contact: { id: 'k1', name: 'Alice', email: 'alice@example.com', phone: null },
  vendor: { id: 'v1' },
};

let mutateAsync: ReturnType<typeof vi.fn>;

function renderToolbar(conversation: typeof baseConversation = baseConversation) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<ConversationToolbar conversation={conversation as never} />, { wrapper: Wrapper });
}

beforeEach(() => {
  mutateAsync = vi.fn().mockResolvedValue({});
  // Two agents so the open listbox offers a concrete assignee to pick.
  inbox.useAgents.mockReturnValue({
    data: [
      { id: 'a1', first_name: 'Bob', email: 'bob@x.com' },
      { id: 'a2', first_name: 'Carol', email: 'carol@x.com' },
    ],
  });
  inbox.useTeamOptions.mockReturnValue({ data: [{ id: 'tm1', name: 'Support' }] });
  inbox.useTags.mockReturnValue({ data: [{ id: 'tg1', name: 'VIP', color: null }] });
  inbox.useAddTagToConversation.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  inbox.useUpdateConversation.mockReturnValue({ mutateAsync });
  inbox.useLinkedTickets.mockReturnValue({ data: [], isLoading: false });
});

describe('ConversationToolbar — agent assignment', () => {
  it('renders the assignment control with the unassigned label', () => {
    renderToolbar();
    const agentSelect = screen.getByLabelText('conversation.agent');
    expect(agentSelect).toBeInTheDocument();
    // No assigned_agent on the conversation → the trigger shows "unassigned".
    expect(agentSelect).toHaveTextContent('conversation.unassigned');
  });

  it('assigns an agent — fires the update mutation with the assigned_agent id', async () => {
    renderToolbar();
    // Open the agent dropdown (combobox trigger), then pick "Bob".
    await userEvent.click(screen.getByLabelText('conversation.agent'));
    const listbox = await screen.findByRole('listbox');
    // role="option" is the <li>; the click handler lives on the <button> inside it.
    await userEvent.click(within(listbox).getByRole('button', { name: 'Bob' }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ id: 'c1', patch: { assigned_agent: 'a1' } });
  });

  it('reassigning to "unassigned" sends assigned_agent: null', async () => {
    renderToolbar({ ...baseConversation, assigned_agent: 'a1' });
    await userEvent.click(screen.getByLabelText('conversation.agent'));
    const listbox = await screen.findByRole('listbox');
    await userEvent.click(within(listbox).getByRole('button', { name: 'conversation.unassigned' }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    // Empty-string option value is normalised to null in the toolbar handler.
    expect(mutateAsync).toHaveBeenCalledWith({ id: 'c1', patch: { assigned_agent: null } });
  });
});
