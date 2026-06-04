import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

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
}));
vi.mock('../src/features/inbox/api.js', () => inbox);

// CreateTicketDialog pulls in its own api/auth; stub it to a marker.
vi.mock('../src/features/tickets/CreateTicketDialog.js', () => ({
  CreateTicketDialog: () => <div>create-ticket-dialog</div>,
}));

import { ConversationToolbar } from '../src/features/conversation/ConversationToolbar.js';

const conversation = {
  id: 'c1',
  status: 'open' as const,
  priority: 'high' as const,
  last_message_at: null,
  unread_count_agent: 0,
  assigned_agent: null,
  assigned_team: null,
  contact: { id: 'k1', name: 'Alice', email: 'alice@example.com', phone: null },
  vendor: { id: 'v1' },
};

function renderToolbar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<ConversationToolbar conversation={conversation as never} />, { wrapper: Wrapper });
}

beforeEach(() => {
  inbox.useAgents.mockReturnValue({ data: [{ id: 'a1', first_name: 'Bob', email: 'b@x.com' }] });
  inbox.useTeamOptions.mockReturnValue({ data: [{ id: 'tm1', name: 'Support' }] });
  inbox.useTags.mockReturnValue({ data: [{ id: 'tg1', name: 'VIP', color: null }] });
  inbox.useAddTagToConversation.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  inbox.useUpdateConversation.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('ConversationToolbar', () => {
  it('renders the contact identity and status controls', () => {
    renderToolbar();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    // The four ghost selects expose their aria-labels.
    expect(screen.getByLabelText('conversation.status')).toBeInTheDocument();
    expect(screen.getByLabelText('conversation.priority')).toBeInTheDocument();
  });

  it('opens the create-ticket dialog from the toolbar', async () => {
    renderToolbar();
    await userEvent.click(screen.getByText(/tickets.createTitle/));
    expect(screen.getByText('create-ticket-dialog')).toBeInTheDocument();
  });
});
