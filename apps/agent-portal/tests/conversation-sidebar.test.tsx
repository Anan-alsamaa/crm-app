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
  // Not a hook — the sidebar calls it to find the vendor that governs the AI
  // budget, and mocking the module wholesale would otherwise blank it out.
  conversationVendorId: (c: { vendor?: { id?: string } | string | null }) =>
    typeof c?.vendor === 'string' ? c.vendor : (c?.vendor?.id ?? ''),
  useLinkedTickets: vi.fn(),
  useCustomerHistory: vi.fn(() => ({ data: [] })),
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
  // The AI panel needs a vendor: that is what the monthly AI budget is
  // charged against, so no vendor means no panel.
  vendor: { id: 'v1' },
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
    expect(screen.getByText('custom-fields')).toBeInTheDocument();
  });

  it('leaves AI assistance to the composer, not the sidebar', () => {
    // The panel moved to sit directly above the reply box at the owner's
    // request: an agent reaches for it WHILE writing, so it belongs beside
    // the composer rather than in a panel they must look away to find. It is
    // still AGENT-facing — a suggestion lands in the composer for the agent to
    // edit and send, so nothing reaches the customer unreviewed (3588276).
    inbox.useConversation.mockReturnValue({ data: convo, isLoading: false });
    renderSidebar();
    expect(screen.queryByText('ai-panel')).not.toBeInTheDocument();
  });

  it('orders the panels the way the operations team reads them', () => {
    inbox.useConversation.mockReturnValue({ data: convo, isLoading: false });
    inbox.useLinkedTickets.mockReturnValue({
      data: [{ id: 't1', subject: 'Refund', status: 'open', priority: 'high' }],
      isLoading: false,
    });
    renderSidebar({
      media: [{ id: 'f1', filename: 'a.png', type: 'image/png', filesize: 10 }],
    });

    // Assert on the order of the section HEADINGS, not raw text: the stat tile
    // at the top of the panel reuses the "linked tickets" label, so a plain
    // text search matches that instead of the section.
    const headings = screen.getAllByRole('heading').map((h) => h.textContent ?? '');
    const at = (label: string) => headings.findIndex((h) => h.includes(label));

    const contact = at('sidebar.contact');
    const tickets = at('sidebar.linkedTickets');
    const tags = at('sidebar.tags');
    const media = at('Shared media');

    expect(contact).toBeGreaterThanOrEqual(0);
    expect(tickets).toBeGreaterThan(contact);
    expect(tags).toBeGreaterThan(tickets);
    expect(media).toBeGreaterThan(tags);
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
