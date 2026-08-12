import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
  // Detail can pull files already shared in the linked chat.
  useConversationAttachments: () => ({ data: [], isLoading: false }),
  useAttachExistingFileToTicket: () => ({
    mutateAsync: () => Promise.resolve({}),
    isPending: false,
  }),
}));
vi.mock('../src/features/tickets/api.js', () => hooks);
// Detail uses agent/team option lists + the current user.
vi.mock('../src/features/inbox/api.js', () => ({
  useAgents: () => ({ data: [] }),
  useTeamOptions: () => ({ data: [] }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'agent-1', first_name: 'Sara', last_name: null, email: null } }),
}));
// The list is now the operations complaints table, fed by the agent's own
// complaints and joined against the store master.
const complaints = vi.hoisted(() => ({ useMyComplaints: vi.fn() }));
vi.mock('../src/features/complaints/api.js', () => complaints);
vi.mock('../src/features/tickets/useStoreMatch.js', async () => {
  const { buildStoreIndex } = await import('@yiji/shared-types');
  return {
    useStoreIndex: () => ({ index: buildStoreIndex([]), isLoading: false, count: 0 }),
    // The detail pane's complaint panel lists branches to pick from.
    useStores: () => ({ data: [], isLoading: false }),
  };
});

import { TicketsPage } from '../src/features/tickets/TicketsPage.js';

/** Where the router currently is, so navigation can be asserted. */
let currentPath = '/tickets';
function LocationProbe() {
  currentPath = useLocation().pathname;
  return null;
}

function renderPage(initial = '/tickets') {
  currentPath = initial;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        {children}
        <LocationProbe />
      </MemoryRouter>
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

/** What the table actually renders — the ops report row, not the ticket. */
const complaintRow = {
  id: 't1',
  date: '2026-01-01',
  time: '00:00',
  chain: '',
  area: '',
  brand: '',
  city: '',
  restaurantName: '',
  storeMapped: false,
  serviceType: 'Delivery',
  complaintType: 'Refund',
  customerName: 'Alice',
  customerMobile: '+966500000000',
  complaintDescription: 'I want a refund',
  responseDesc: '',
  complaintSource: '',
  orderAmount: null,
  orderNumber: '946641',
  communicationMethod: '',
  couponCode: '',
  couponValue: null,
  couponPercent: null,
  complaintStatus: 'open',
  agent: 'Sara',
  compensation: '',
  storeSnapshot: null,
  subject: 'Refund please',
  firstRespondedAt: null,
  firstResponseDueAt: null,
};

beforeEach(() => {
  complaints.useMyComplaints.mockReset();
  complaints.useMyComplaints.mockReturnValue({ data: [complaintRow], isLoading: false });
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
    complaints.useMyComplaints.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText('tickets.empty')).toBeInTheDocument();
  });

  it('lists tickets in the operations report format, not as bespoke rows', () => {
    renderPage();
    // The columns the ops team read: the order and the complaint type. Every
    // column of the report is rendered now, including the date hierarchy they
    // pivot on — the table and the export are the same report.
    expect(screen.getByText('946641')).toBeInTheDocument();
    expect(screen.getByText('Refund')).toBeInTheDocument();
    for (const header of ['Year', 'Month', 'Week', 'Day', 'Coupon %']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    // And the export that makes the table worth having.
    expect(screen.getByRole('button', { name: /Export to Excel/ })).toBeInTheDocument();
  });

  it('opens the ticket on its own page when a row is chosen', async () => {
    // Not a panel under the table: a row is 27 columns wide, which leaves no
    // useful room beneath it, and the ticket page is the layout operations
    // asked for.
    renderPage();
    await userEvent.click(screen.getByText('946641'));
    await waitFor(() => expect(currentPath).toBe('/tickets/t1'));
    expect(screen.queryByText('Mark first response')).toBeNull();
  });

  it('still shows the detail when the ticket page is opened directly', async () => {
    // Deep links (notifications, the command palette) must still render the
    // ticket, not just the list. Uses the ?id= form because this harness
    // mounts the page directly rather than under a :ticketId route.
    renderPage('/tickets?id=t1');
    await waitFor(() => expect(screen.getByText('Mark first response')).toBeInTheDocument());
    // The description now appears in the table's own column as well as the
    // detail pane, so assert on a control only the pane has.
    expect(screen.getByText('SLA')).toBeInTheDocument();
  });

  it('opens a row from the keyboard, not only by mouse', async () => {
    renderPage();
    const row = screen.getByText('946641').closest('tr')!;
    row.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(currentPath).toBe('/tickets/t1'));
  });
});
