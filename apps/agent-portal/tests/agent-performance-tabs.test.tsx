import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type {
  PerformanceCouponRow,
  PerformanceTicketRow,
} from '../src/features/performance/api.js';

/*
 * The Chats / Tickets / Coupons sub-pages and the search box (owner,
 * 2026-10-07): "Faisal (agent) has assigned a coupon which came for admin
 * approval, however in the Agent performance page I'm unable to find the
 * ticket."
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = (o?.defaultValue ?? k) as string;
      if (o) {
        for (const [key, val] of Object.entries(o)) {
          if (key === 'defaultValue') continue;
          s = s.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(val));
        }
      }
      return s;
    },
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const inbox = vi.hoisted(() => ({ useAgents: vi.fn() }));
vi.mock('../src/features/inbox/api.js', () => inbox);

// Faisal is the one looking — the page opens on his own work.
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'faisal', first_name: 'Faisal' } }),
}));

const perf = vi.hoisted(() => ({
  useChatTimings: vi.fn(),
  useCsatByConversation: vi.fn(() => ({ data: new Map<string, number>() })),
  useTicketPerformance: vi.fn(),
  useCouponPerformance: vi.fn(),
}));
vi.mock('../src/features/performance/api.js', () => perf);
// No working hours configured: the wall clock (owner, 2026-10-08).
vi.mock('../src/lib/sla-hours.js', () => ({
  useSlaHours: () => ({ data: { chat: null, ticket: null }, isLoading: false }),
}));

import { AgentPerformancePage } from '../src/features/performance/AgentPerformancePage.js';

function renderPage(path = '/performance') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<AgentPerformancePage />, { wrapper: Wrapper });
}

const chats = [
  {
    conversationId: 'conv-nora',
    agentId: 'faisal',
    agentName: 'Faisal',
    firstCustomerAt: '2026-10-06T10:00:00.000Z',
    firstAgentAt: '2026-10-06T10:01:00.000Z',
    solvedAt: null,
    startedAt: '2026-10-06T10:00:00.000Z',
    customer: 'Nora',
    customerPhone: '+966501112222',
    orderId: '946641',
    subject: 'Late order',
    ticketId: '7001',
  },
  {
    conversationId: 'conv-ali',
    agentId: 'faisal',
    agentName: 'Faisal',
    firstCustomerAt: '2026-10-05T10:00:00.000Z',
    firstAgentAt: '2026-10-05T10:02:00.000Z',
    solvedAt: null,
    startedAt: '2026-10-05T10:00:00.000Z',
    customer: 'Ali',
    customerPhone: '0559998888',
    orderId: null,
    subject: 'Missing item',
    ticketId: null,
  },
];

const ticket = (over: Partial<PerformanceTicketRow> = {}): PerformanceTicketRow => ({
  id: '8123',
  subject: 'Cold food',
  complaintType: 'Food quality',
  orderId: '555001',
  status: 'pending',
  assignedAgent: 'branch-team',
  // Raised by Faisal, assigned elsewhere — still his ticket.
  createdBy: 'faisal',
  createdAt: '2026-10-06T09:00:00.000Z',
  resolvedAt: null,
  contactName: '+966503334444',
  contactPhone: '+966503334444',
  customerPhone: null,
  coupon: { code: 'SORRY25', status: 'pending' },
  ...over,
});

const coupon = (over: Partial<PerformanceCouponRow> = {}): PerformanceCouponRow => ({
  id: 'cp-1',
  coupon_code: 'SORRY25',
  coupon_value: 25,
  coupon_percent: null,
  discount_category: 'Amount',
  status: 'pending',
  date_created: '2026-10-06T09:05:00.000Z',
  order_id: null,
  customer_phone: null,
  ticket: { id: '8123', subject: 'Cold food', order_id: '555001', complaint_type: 'Food quality' },
  contact: { id: 'ct-1', name: null, phone: '+966503334444' },
  requested_by: { id: 'faisal', first_name: 'Faisal', email: null },
  delivery_excluded: false,
  yiji_coupon_id: null,
  awaiting_signup_at: null,
  ticketId: '8123',
  ...over,
});

beforeEach(() => {
  sessionStorage.clear();
  navigate.mockReset();
  inbox.useAgents.mockReturnValue({
    data: [
      { id: 'faisal', first_name: 'Faisal', email: 'faisal@yiji.test' },
      { id: 'branch-team', first_name: 'Branch', email: 'branch@yiji.test' },
    ],
  });
  perf.useChatTimings.mockReturnValue({ data: chats, isLoading: false });
  perf.useTicketPerformance.mockReturnValue({
    data: [
      ticket(),
      ticket({
        id: '8124',
        subject: 'Wrong order',
        complaintType: null,
        orderId: null,
        status: 'solved',
        assignedAgent: 'faisal',
        createdAt: '2026-10-05T09:00:00.000Z',
        resolvedAt: '2026-10-05T10:30:00.000Z',
        contactName: 'Huda',
        contactPhone: '0507776666',
        coupon: null,
      }),
    ],
    isLoading: false,
    error: null,
  });
  perf.useCouponPerformance.mockReturnValue({
    data: [coupon()],
    isLoading: false,
    error: null,
  });
});

describe('Agent performance — sub-pages', () => {
  it('shows three tabs and opens on Chats', () => {
    renderPage();
    const tabs = screen.getByRole('tablist', { name: 'Performance views' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Chats', 'Tickets', 'Coupons']);
    expect(within(tabs).getByRole('tab', { name: 'Chats' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('table', { name: 'Chat by chat' })).toBeInTheDocument();
  });

  it('switches tabs, and deep-links to one through ?tab=', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: 'Tickets' }));
    expect(screen.getByRole('table', { name: 'Ticket by ticket' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Chat by chat' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Coupons' }));
    expect(screen.getByRole('table', { name: 'Coupon by coupon' })).toBeInTheDocument();
  });

  it('opens straight on the tab named in the URL', () => {
    renderPage('/performance?tab=coupons');
    expect(screen.getByRole('table', { name: 'Coupon by coupon' })).toBeInTheDocument();
  });

  it('lists a ticket the agent RAISED but does not own, and opens it on click', async () => {
    const user = userEvent.setup();
    renderPage('/performance?tab=tickets');
    const table = screen.getByRole('table', { name: 'Ticket by ticket' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    // The customer's +966 name renders as the canonical 05 number.
    expect(within(rows[0]!).getByText('0503334444')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('#555001')).toBeInTheDocument();
    // The linked coupon request, with where it stands.
    expect(within(rows[0]!).getByText('SORRY25')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Waiting for approval')).toBeInTheDocument();
    // Solved one: 1h 30m to solve.
    expect(within(rows[1]!).getByText('Solved')).toBeInTheDocument();
    await user.click(within(rows[0]!).getByText('Food quality'));
    expect(navigate).toHaveBeenCalledWith('/tickets/8123');
  });

  it('summarises the tickets: count, pending, solved', () => {
    renderPage('/performance?tab=tickets');
    const summary = screen.getByRole('region', { name: 'Ticket summary' });
    expect(within(summary).getByText('2')).toBeInTheDocument();
    expect(within(summary).getAllByText('1')).toHaveLength(2);
  });

  it('lists Faisal’s pending coupon and opens its ticket on click', async () => {
    const user = userEvent.setup();
    renderPage('/performance?tab=coupons');
    const table = screen.getByRole('table', { name: 'Coupon by coupon' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(within(row).getByText('SORRY25')).toBeInTheDocument();
    expect(within(row).getByText('Waiting for approval')).toBeInTheDocument();
    expect(within(row).getByText('0503334444')).toBeInTheDocument();
    expect(within(row).getByText('Yes')).toBeInTheDocument();
    await user.click(within(row).getByText('SORRY25'));
    expect(navigate).toHaveBeenCalledWith('/tickets/8123');
    // Asked for Faisal's own requests — the signed-in agent.
    expect(perf.useCouponPerformance.mock.calls[0]![0]).toMatchObject({ agentId: 'faisal' });
  });

  it('names each coupon stage the way the agent repeats it to a customer', () => {
    perf.useCouponPerformance.mockReturnValue({
      data: [
        coupon({ id: 'a', coupon_code: 'A1', status: 'assigned' }),
        coupon({
          id: 'b',
          coupon_code: 'B1',
          status: 'approved',
          awaiting_signup_at: '2026-10-06T10:00:00.000Z',
        }),
        coupon({
          id: 'c',
          coupon_code: 'C1',
          status: 'assigned',
          delivery_excluded: true,
          yiji_coupon_id: 'y-1',
          ticket: null,
        }),
        coupon({ id: 'd', coupon_code: 'D1', status: 'rejected' }),
      ],
      isLoading: false,
      error: null,
    });
    renderPage('/performance?tab=coupons');
    const table = screen.getByRole('table', { name: 'Coupon by coupon' });
    expect(within(table).getByText('Delivered to Yiji')).toBeInTheDocument();
    expect(within(table).getByText('Waiting for the customer to join Yiji')).toBeInTheDocument();
    expect(within(table).getByText('Created on Yiji, not assigned')).toBeInTheDocument();
    expect(within(table).getByText('Rejected')).toBeInTheDocument();
    expect(within(table).getByText('No')).toBeInTheDocument();
  });

  it('opens the compensation list for a coupon with no ticket', async () => {
    perf.useCouponPerformance.mockReturnValue({
      data: [
        coupon({ ticket: null, ticketId: null, order_id: '777', customer_phone: '0501231234' }),
      ],
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    renderPage('/performance?tab=coupons');
    await user.click(screen.getByText('SORRY25'));
    expect(navigate).toHaveBeenCalledWith('/compensation');
  });

  /* A WeCare agent reads only tickets ASSIGNED to them, so the expansion of a
     ticket that went to someone else is NULL — the stored id still links it. */
  it('still opens the ticket when the agent cannot read the ticket itself', async () => {
    perf.useCouponPerformance.mockReturnValue({
      data: [coupon({ ticket: null, ticketId: '8123' })],
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    renderPage('/performance?tab=coupons');
    expect(screen.getByText('Ticket 8123')).toBeInTheDocument();
    await user.click(screen.getByText('SORRY25'));
    expect(navigate).toHaveBeenCalledWith('/tickets/8123');
  });

  it('says calmly when the coupon list is refused', () => {
    perf.useCouponPerformance.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: { response: { status: 403 } },
    });
    renderPage('/performance?tab=coupons');
    expect(screen.getByText('You don’t have access to coupons.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Agent performance — search', () => {
  const chatRows = () =>
    within(screen.getByRole('table', { name: 'Chat by chat' }))
      .getAllByRole('row')
      .slice(1);

  it.each(['0501112222', '+966501112222', '966501112222', '50111'])(
    'finds a chat by the customer number typed as %s',
    async (typed) => {
      const user = userEvent.setup();
      renderPage();
      expect(chatRows()).toHaveLength(2);
      await user.type(screen.getByRole('searchbox', { name: 'Search' }), typed);
      await waitFor(() => expect(chatRows()).toHaveLength(1));
      expect(within(chatRows()[0]!).getByText('Nora')).toBeInTheDocument();
    },
  );

  it('finds a chat by its ticket id and by its title', async () => {
    const user = userEvent.setup();
    renderPage();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    await user.type(box, '7001');
    await waitFor(() => expect(chatRows()).toHaveLength(1));
    await user.clear(box);
    await user.type(box, 'missing item');
    // Waits on the CONTENT: the previous search also left one row.
    await waitFor(() => expect(within(chatRows()[0]!).getByText('Ali')).toBeInTheDocument());
    expect(chatRows()).toHaveLength(1);
  });

  it('applies to the active tab: tickets by id, title and number', async () => {
    const user = userEvent.setup();
    renderPage('/performance?tab=tickets');
    const rows = () =>
      within(screen.getByRole('table', { name: 'Ticket by ticket' }))
        .getAllByRole('row')
        .slice(1);
    const box = screen.getByRole('searchbox', { name: 'Search' });
    await user.type(box, '8124');
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]!).getByText('Wrong order')).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'food');
    // Waits on the CONTENT: the previous search also left one row.
    await waitFor(() => expect(within(rows()[0]!).getByText('Food quality')).toBeInTheDocument());
    expect(rows()).toHaveLength(1);
    await user.clear(box);
    await user.type(box, '+966 50 777 6666');
    await waitFor(() => expect(within(rows()[0]!).getByText('Huda')).toBeInTheDocument());
    expect(rows()).toHaveLength(1);
  });

  it('keeps the tab and the search when the agent leaves and comes back', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Tickets' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'food');
    await waitFor(() =>
      expect(sessionStorage.getItem('agent-performance:faisal')).toContain('"search":"food"'),
    );
    first.unmount();
    renderPage();
    expect(screen.getByRole('tab', { name: 'Tickets' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('food');
  });
});
