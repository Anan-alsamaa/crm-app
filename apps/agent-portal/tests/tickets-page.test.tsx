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
// The list is fed by the agent's own complaints, joined against the store
// master so branch attribution matches the manager's report exactly.
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

/** The list renders the ops report row, not the raw ticket. */
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

  it('lists tickets as readable rows, not as a 27-column sheet', () => {
    // The operations report belongs to the manager's portal. An agent works one
    // complaint at a time and reads the queue at a glance, which a horizontally
    // scrolling table does not give them.
    renderPage();
    expect(screen.getByText('Refund please')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Coupon %' })).not.toBeInTheDocument();
  });

  it('keeps the branch on the row, which is what the ops team reconcile on', () => {
    // Losing the table must not lose the attribution. "Not mapped" is shown as
    // itself so a gap stays visible rather than reading as blank.
    complaints.useMyComplaints.mockReturnValue({
      data: [{ ...complaintRow, restaurantName: 'LCP-032 Masief Plaza', city: 'Riyadh 1' }],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText(/LCP-032 Masief Plaza/)).toBeInTheDocument();
  });

  it('leads the row with the complaint type, the way the ops sheet is scanned', () => {
    // A distinct type, so it cannot be confused with the subject "Refund please".
    complaints.useMyComplaints.mockReturnValue({
      data: [{ ...complaintRow, complaintType: 'Late order' }],
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText(/Late order/)).toBeInTheDocument();
  });

  it('opens the ticket beside the list rather than navigating away', async () => {
    // Master-detail again: the agent keeps the queue in view while working a
    // ticket, which is the whole reason for reverting the table.
    renderPage();
    await userEvent.click(screen.getByText('Refund please'));
    await waitFor(() => expect(screen.getByText('SLA')).toBeInTheDocument());
    expect(currentPath).toBe('/tickets');
  });

  it('still shows the detail when the ticket page is opened directly', async () => {
    // Deep links (notifications, the command palette) must render the ticket,
    // not just the list. Uses the ?id= form because this harness mounts the
    // page directly rather than under a :ticketId route.
    renderPage('/tickets?id=t1');
    await waitFor(() => expect(screen.getByText('SLA')).toBeInTheDocument());
  });
});

describe('TicketsPage — marking a ticket solved', () => {
  it('offers "Mark as solved" rather than only logging a first response', async () => {
    renderPage('/tickets?id=t1');
    await waitFor(() => expect(screen.getByText('Mark as solved')).toBeInTheDocument());
    expect(screen.queryByText('Mark first response')).toBeNull();
  });

  it('actually resolves the ticket, not just the SLA timer', async () => {
    // The old control only stamped first_responded_at and said so in its own
    // hint. Renaming that to "solved" without changing it would have left every
    // solved ticket sitting in an unresolved state in every report.
    const mutateAsync = vi.fn().mockResolvedValue({});
    hooks.useUpdateTicket.mockReturnValue({ mutateAsync });
    renderPage('/tickets?id=t1');
    await waitFor(() => expect(screen.getByText('Mark as solved')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Mark as solved'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const patch = mutateAsync.mock.calls[0]![0].patch;
    expect(patch.status).toBe('resolved');
    expect(patch.resolved_at).toEqual(expect.any(String));
  });

  it('backfills a missing first response so the SLA report does not read "never replied"', async () => {
    // Nothing else stamps first_responded_at. A solved ticket with a null there
    // claims the agent never answered, which is a worse lie than "no later
    // than the moment it was solved".
    const mutateAsync = vi.fn().mockResolvedValue({});
    hooks.useUpdateTicket.mockReturnValue({ mutateAsync });
    renderPage('/tickets?id=t1');
    await waitFor(() => expect(screen.getByText('Mark as solved')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Mark as solved'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0].patch.first_responded_at).toEqual(expect.any(String));
  });

  it('leaves an existing first response alone', async () => {
    // It is a floor for a missing value, never a correction of a real one.
    const mutateAsync = vi.fn().mockResolvedValue({});
    hooks.useUpdateTicket.mockReturnValue({ mutateAsync });
    hooks.useTicket.mockReturnValue({
      data: { ...ticket, first_responded_at: '2026-01-01T09:00:00.000Z' },
      isLoading: false,
    });
    renderPage('/tickets?id=t1');
    await waitFor(() => expect(screen.getByText('Mark as solved')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Mark as solved'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0].patch).not.toHaveProperty('first_responded_at');
  });

  it('shows when it was solved instead of the button, once resolved', async () => {
    hooks.useTicket.mockReturnValue({
      data: { ...ticket, status: 'resolved', resolved_at: '2026-01-02T00:00:00.000Z' },
      isLoading: false,
    });
    renderPage('/tickets?id=t1');
    await waitFor(() => expect(screen.getByText(/Solved/)).toBeInTheDocument());
    expect(screen.queryByText('Mark as solved')).toBeNull();
  });
});
