import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

// Mock the tickets feature api: canned query/mutation objects.
const hooks = vi.hoisted(() => ({
  useTickets: vi.fn(),
  useTicket: vi.fn(),
  useTicketEvents: vi.fn(),
  useUpdateTicket: vi.fn(),
  // Ticket detail now supports notes + attachments.
  useAddTicketNote: () => ({ mutateAsync: () => Promise.resolve({}), isPending: false }),
  useAddTicketAttachment: () => ({ mutateAsync: () => Promise.resolve({}) }),
  useRemoveTicketAttachment: () => ({ mutateAsync: () => Promise.resolve({}) }),
}));
vi.mock('../src/features/tickets/api.js', () => hooks);
// Detail uses agent/team option lists + the current user.
vi.mock('../src/features/inbox/api.js', () => ({
  useAgents: () => ({ data: [] }),
  useTeamOptions: () => ({ data: [] }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'agent-1' } }),
}));
// Force desktop so the master+detail layout (and the select prompt) render.
vi.mock('@yiji/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@yiji/ui')>()),
  useIsDesktop: () => true,
}));

import { TicketsPage } from '../src/features/tickets/TicketsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tickets']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<TicketsPage />, { wrapper: Wrapper });
}

const ticket = {
  id: 't1',
  subject: 'Refund please',
  description: 'I want a refund',
  status: 'open',
  priority: 'high',
  assigned_agent: null,
  assigned_team: null,
  conversation: null,
  contact: { id: 'k1', name: 'Alice', email: 'a@b.com' },
  first_response_due_at: null,
  resolution_due_at: null,
  first_responded_at: null,
  date_created: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  hooks.useTickets.mockReset();
  hooks.useTicket.mockReset();
  hooks.useTicketEvents.mockReset();
  hooks.useUpdateTicket.mockReset();
  hooks.useTicket.mockReturnValue({ data: ticket, isLoading: false });
  hooks.useTicketEvents.mockReturnValue({ data: [], isLoading: false });
  hooks.useUpdateTicket.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('TicketsPage', () => {
  it('shows the empty state when there are no tickets', () => {
    hooks.useTickets.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText('tickets.empty')).toBeInTheDocument();
  });

  it('renders the ticket list and the select prompt before selection', () => {
    hooks.useTickets.mockReturnValue({ data: [ticket], isLoading: false });
    renderPage();
    expect(screen.getByText('Refund please')).toBeInTheDocument();
    expect(screen.getByText('Open a ticket')).toBeInTheDocument();
  });

  it('opens ticket detail when a list item is clicked', async () => {
    hooks.useTickets.mockReturnValue({ data: [ticket], isLoading: false });
    renderPage();
    await userEvent.click(screen.getByText('Refund please'));
    // Detail header shows the contact name and the SLA section. The first-response
    // action renders its defaultValue ("Mark first response") in tests since no
    // locale resources are loaded.
    await waitFor(() => expect(screen.getByText('Mark first response')).toBeInTheDocument());
    // Detail-only: the description and the SLA section heading.
    expect(screen.getByText('I want a refund')).toBeInTheDocument();
    expect(screen.getByText('SLA')).toBeInTheDocument();
  });
});
