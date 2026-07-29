import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const inbox = vi.hoisted(() => ({
  useConversation: vi.fn(),
  useLinkedTickets: vi.fn(),
  // ConversationSidebar now renders <ConversationTags>, which reads these.
  useTags: () => ({ data: [] }),
  useCreateTag: () => ({ mutateAsync: () => Promise.resolve({ id: 't', name: '', color: null }) }),
  useAddTagToConversation: () => ({ mutateAsync: () => Promise.resolve({}) }),
  useRemoveTagFromConversation: () => ({ mutateAsync: () => Promise.resolve({}) }),
  useDeleteTag: () => ({ mutateAsync: () => Promise.resolve({}), isPending: false }),
}));
vi.mock('../src/features/inbox/api.js', () => inbox);

// Heavy children pull in AI / directus — stub them to markers so the sidebar
// renders cheaply and deterministically.
vi.mock('../src/features/ai/AiPanel.js', () => ({ AiPanel: () => <div>ai-panel</div> }));
vi.mock('../src/features/custom-fields/CustomFieldsSection.js', () => ({
  CustomFieldsSection: () => <div>custom-fields</div>,
}));

import { ConversationSidebar } from '../src/features/conversation/ConversationSidebar.js';

function renderSidebar(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<ConversationSidebar conversationId="c1" {...props} />, { wrapper: Wrapper });
}

const convo = {
  id: 'c1',
  status: 'open',
  priority: 'medium',
  contact: { id: 'k1', name: 'Alice', email: 'alice@example.com', phone: '555-1' },
  tags: [{ id: 'j1', tags_id: { id: 'tg1', name: 'VIP', color: null } }],
};

beforeEach(() => {
  inbox.useConversation.mockReset();
  inbox.useLinkedTickets.mockReset();
  inbox.useLinkedTickets.mockReturnValue({ data: [], isLoading: false });
});

describe('ConversationSidebar', () => {
  it('shows a spinner while the conversation loads', () => {
    inbox.useConversation.mockReturnValue({ data: undefined, isLoading: true });
    renderSidebar();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders contact details, tags and child panels', () => {
    inbox.useConversation.mockReturnValue({ data: convo, isLoading: false });
    renderSidebar();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('ai-panel')).toBeInTheDocument();
    expect(screen.getByText('custom-fields')).toBeInTheDocument();
  });

  it('renders internal notes and the no-tickets empty state', () => {
    inbox.useConversation.mockReturnValue({ data: convo, isLoading: false });
    renderSidebar({
      notes: [{ id: 'n1', content: 'private note', date_created: null, sender_type: 'agent' }],
    });
    expect(screen.getByText('private note')).toBeInTheDocument();
    expect(screen.getByText('sidebar.noTickets')).toBeInTheDocument();
  });

  it('lists linked tickets when present', () => {
    inbox.useConversation.mockReturnValue({ data: convo, isLoading: false });
    inbox.useLinkedTickets.mockReturnValue({
      data: [{ id: 't1', subject: 'Refund', status: 'open', priority: 'high' }],
      isLoading: false,
    });
    renderSidebar();
    expect(screen.getByText('Refund')).toBeInTheDocument();
  });
});
