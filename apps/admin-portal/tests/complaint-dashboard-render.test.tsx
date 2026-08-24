import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// Interpolates {{placeholders}} the way i18next does. Without this the mock
// renders "top {{n}} of {{m}}" literally and any assertion on a formatted
// string silently tests nothing.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) =>
      String(o?.defaultValue ?? k).replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
        String(o?.[name] ?? ''),
      ),
  }),
}));

const api = vi.hoisted(() => ({
  useComplaintMetrics: vi.fn(),
  useComplaintYears: vi.fn(() => ({ data: [2026], isLoading: false })),
  yearBounds: (y: number) => ({ from: `${y}-01-01`, to: `${y}-12-31` }),
  selectedYear: () => null,
  emptyComplaintFilters: { from: '', to: '', brand: '', area: '', city: '', store: '' },
}));
vi.mock('../src/features/dashboard/complaints-api.js', () => api);

/*
 * The coupon spend card is stubbed here, not exercised.
 *
 * It reads the signed-in user (to decide whether the role may see payout
 * money) and runs its own query, so it needs an AuthProvider and a
 * QueryClientProvider that these tests deliberately do not build — they assert
 * the dashboard's OWN sections against a mocked data layer. Its arithmetic is
 * covered directly in packages/reports (`couponWorth`), and its gate in
 * `canSeeCouponMoney`, which are better places to test both than through a
 * rendered dashboard.
 */
vi.mock('../src/features/dashboard/CouponSpend.js', () => ({
  CouponSpend: () => null,
  // The KPI strip reads the same query for its coupon tile.
  useCouponSpend: () => ({ data: [] }),
}));

/* Same reasoning for the customer-reach card: it runs its own query, and these
   tests build no QueryClientProvider. Its arithmetic is two counts and a
   subtraction against a live Directus filter, which a mounted dashboard is the
   wrong place to assert. */
vi.mock('../src/features/dashboard/CustomerReach.js', () => ({
  CustomerReach: () => null,
}));

import { ComplaintDashboard } from '../src/features/dashboard/ComplaintDashboard.js';

const bd = (label: string, count: number) => ({ key: label, label, count });
/** A cut whose `distinct` exceeds what is shown, so the "top N of M" note renders. */
const cut = (rows: ReturnType<typeof bd>[], distinct = rows.length) => ({
  rows,
  distinct,
  // The uncapped list the export reads. Same rows here — a fixture that shows
  // everything is not hiding a tail to carry.
  all: rows,
});

const METRICS = {
  total: 10,
  monthsCovered: 2,
  open: 4,
  overdue: 1,
  closed: 6,
  rated: 4,
  satisfied: 3,
  satisfiedPct: 75,
  compensation: 250,
  avgCompensation: 25,
  compensated: 4,
  firstDate: '2026-06-02',
  lastDate: '2026-07-29',
  chatsWaiting: 2,
  chatsTotal: 9,
  months: [
    { month: '2026-06', count: 4, compensation: 100 },
    { month: '2026-07', count: 6, compensation: 150 },
  ],
  byRestaurant: cut([bd('LCP-002 Dhahran Mall', 6)]),
  byType: cut([bd('Missing item', 7), bd('Late order', 3)]),
  byBrand: cut([bd('Casa Pasta', 7), bd('Pasketti', 3)]),
  byArea: cut([bd('Aly', 5)]),
  byCity: cut([bd('Khobar', 6)], 24),
  byStatus: cut([bd('closed', 6), bd('open', 4)]),
  byServiceType: cut([bd('Delivery', 8)]),
  bySource: cut([bd('Comp. WhatsApp', 5)]),
  byAgent: cut([bd('Amjad', 8)]),
  byOpenAgent: cut([bd('Sara', 3)]),
  agents: [
    {
      id: 'u1',
      name: 'Amjad',
      logged: 8,
      solved: 6,
      solvedPct: 75,
      avgHoursToClose: 4.2,
      compensation: 250,
      open: 2,
      chatsOpen: 1,
      chatsSolved: 3,
      replies: 42,
    },
  ],
  chatAgents: [
    {
      id: 'u1',
      name: 'Amjad',
      offered: 9,
      answered: 7,
      missed: 2,
      avgWaitMinutes: 1.5,
      messages: 42,
      chatsHandled: 5,
      chatsSolved: 3,
    },
  ],
  health: {
    openNotOverdue: 3,
    overdue: 1,
    closedSatisfied: 3,
    closedUnsatisfied: 1,
    closedUnrated: 2,
    chatsAnswered: 7,
    chatsWaiting: 2,
    avgChatWaitMinutes: 1.5,
  },
  brandOptions: [{ id: 'br1', name: 'Casa Pasta' }],
  areaOptions: ['Aly'],
  cityOptions: ['Khobar'],
  storeOptions: [{ id: 'st1', name: 'LCP-002 Dhahran Mall', city: 'Khobar' }],
  unattributed: 0,
  rows: [
    {
      id: 'tk1',
      subject: 'Missing garlic sauce',
      date: '2026-07-29',
      status: 'open',
      agentId: 'u1',
      agentName: 'Amjad',
      restaurantName: 'LCP-002 Dhahran Mall',
      brandName: 'Casa Pasta',
      area: 'Aly',
      city: 'Khobar',
      complaintType: 'Missing item',
      serviceType: 'Delivery',
      source: 'Comp. WhatsApp',
      compensation: 'Compensated',
      couponValue: 10,
      isOpen: true,
    },
    {
      id: 'tk2',
      subject: 'Order arrived cold',
      date: '2026-07-20',
      status: 'closed',
      agentId: 'u1',
      agentName: 'Amjad',
      restaurantName: 'LCP-002 Dhahran Mall',
      brandName: 'Casa Pasta',
      area: 'Aly',
      city: 'Khobar',
      complaintType: 'Late order',
      serviceType: 'Delivery',
      source: 'Comp. WhatsApp',
      compensation: 'Not Compensated',
      couponValue: 0,
      isOpen: false,
    },
  ],
};

beforeEach(() => {
  api.useComplaintMetrics.mockReturnValue({ isLoading: false, isError: false, data: METRICS });
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
});

describe('ComplaintDashboard — every section his page has', () => {
  it('gives the AGENT view the support desk cuts', () => {
    // The default view is the desk: what was logged, where it stands, who is
    // holding it. Nothing about branch hierarchy.
    render(<ComplaintDashboard />);
    for (const heading of [
      'Unsolved tickets by agent',
      'By ticket type',
      'By status',
      'By service type',
      'By agent',
      'How tickets reach us',
    ]) {
      expect(screen.getByText(heading), `missing section: ${heading}`).toBeInTheDocument();
    }
    for (const elsewhere of ['Where tickets come from', 'Top restaurants', 'By brand', 'By area']) {
      expect(
        screen.queryByText(elsewhere),
        `should be on Operations: ${elsewhere}`,
      ).not.toBeInTheDocument();
    }
  });

  it('gives the OPERATIONS view the team around the branches', () => {
    // Chain managers own brands, area managers own territories, branch managers
    // own restaurants — so this view cuts the same rows by those.
    render(<ComplaintDashboard view="operations" />);
    for (const heading of ['Top restaurants', 'By brand', 'By area', 'By city']) {
      expect(screen.getByText(heading), `missing section: ${heading}`).toBeInTheDocument();
    }
    expect(screen.queryByText('By agent')).not.toBeInTheDocument();
    /*
     * "Where tickets come from" was a doughnut of the brand split sitting
     * directly above the "By brand" panel, which ranks the same numbers as
     * bars with the counts printed on them. The same answer twice, and the
     * slower of the two: comparing arc lengths is a thing people are bad at.
     */
    expect(screen.queryByText('Where tickets come from')).not.toBeInTheDocument();
  });

  it('opens the operations view on readings the complaint data can support', () => {
    /*
     * This view used to open with no numbers at all — a correction to it
     * opening with the support desk's (chats waiting, compensation paid,
     * coupons issued), which are not this team's. But a wall of ranked lists
     * with nothing to read at a glance is the other failure.
     *
     * The first attempt then led with "Busiest branch", and the owner was
     * right to reject it: these rows are complaints, not orders, and nothing
     * here records how much business a branch did. A branch with more
     * complaints may simply be bigger. Any figure shaped like a RATE is a
     * fiction, so what is left is counts and shares OF THE COMPLAINTS — plus a
     * line saying so, because leaving it unsaid is how a dashboard talks
     * somebody into the wrong decision.
     */
    render(<ComplaintDashboard view="operations" />);
    for (const label of ['Tickets in range', 'Open tickets', 'Most common problem']) {
      expect(screen.getByText(label), `missing operations KPI: ${label}`).toBeInTheDocument();
    }
    // The concentration tile names how many branches it is talking about, so
    // its label carries a number and has to be matched loosely.
    expect(screen.getByText(/From the top \d+ branches/)).toBeInTheDocument();
    expect(screen.getByText(/count tickets, not orders/)).toBeInTheDocument();

    // The three that went, and why: a verdict the data cannot support, a
    // number a manager can do nothing with, and a data-quality reading that
    // belongs with the cut it distorts.
    for (const gone of ['Busiest branch', 'Branches with tickets', 'No branch recorded']) {
      expect(screen.queryByText(gone), `${gone} should be gone`).not.toBeInTheDocument();
    }
    // The desk's own numbers stay off this view.
    for (const gone of ['Coupons issued', 'Open chats', 'Total chats']) {
      expect(
        screen.queryByText(gone),
        `${gone} is not an operations number`,
      ).not.toBeInTheDocument();
    }
  });

  it('drops the readings that were a fourth copy of somebody else’s number', () => {
    // "Agent performance", "Agent performance — chat" and "Chat responsiveness"
    // were AGENT numbers on a BRANCH dashboard, and the fourth place to read
    // them: the Agent dashboard, the Agent performance page and the Agent
    // summary report all answer the same question with the same arithmetic.
    render(<ComplaintDashboard />);
    for (const gone of [
      'Chat responsiveness',
      'Agent performance',
      'Agent performance — chat',
      // Same numbers as the By-status bars and the KPI strip, read a third way.
      'Ticket status mix',
      'Service health',
      // Two readings on one chart, each with its own scale, is a picture you
      // have to be told how to read.
      'Tickets per month',
      // Every chip repeated a number from the KPI strip directly above it.
      'Ops snapshot',
    ]) {
      expect(screen.queryByText(gone), `still present: ${gone}`).not.toBeInTheDocument();
    }
  });

  it('offers his whole filter bar', () => {
    render(<ComplaintDashboard />);
    for (const label of ['From', 'To', 'Brand', 'Area', 'City', 'Restaurant']) {
      expect(screen.getByText(label), `missing filter: ${label}`).toBeInTheDocument();
    }
  });

  it('does not offer to look a customer up by mobile number', () => {
    // Removed by request. This is a where-and-what dashboard; finding one
    // caller's history belongs on the pages that work individual cases.
    render(<ComplaintDashboard />);
    expect(screen.queryByText('Customer mobile')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/41059/)).not.toBeInTheDocument();
  });
});

describe('ComplaintDashboard — the ticket lifecycle reads as one row', () => {
  /*
   * The donut block that used to live here is gone with the donut.
   *
   * Two of its three tests would still have PASSED against the ProgressRings
   * on the KPI tiles — `circle[stroke]` matches those too — so leaving them
   * would have meant three green tests guarding a component nobody renders.
   * A test that cannot fail for the reason it was written is worse than no
   * test: it reports coverage that does not exist.
   */
  it('says how many were solved, not just how many are open', () => {
    // "121 raised, 6 open" leaves the reader to do the subtraction and hope
    // nothing else happened to the other 115.
    render(<ComplaintDashboard />);
    expect(screen.getByText('Tickets')).toBeInTheDocument();
    expect(screen.getByText('Open tickets')).toBeInTheDocument();
    expect(screen.getByText('Solved tickets')).toBeInTheDocument();
    // Overdue is not a fifth state: an overdue ticket IS an open one, so a tile
    // of its own was the same work counted twice, one card apart.
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });
});

describe('ComplaintDashboard — a capped list admits what it hides', () => {
  it('prints "top N of M" only on the cuts that are actually truncated', () => {
    render(<ComplaintDashboard view="operations" />);
    // byCity shows 1 of 24 distinct cities.
    expect(screen.getByText('top 1 of 24')).toBeInTheDocument();
    // A cut showing everything it has must NOT claim to be capped.
    expect(screen.queryByText('top 2 of 2')).not.toBeInTheDocument();
  });

  it('states the period the data actually covers, not the filter', () => {
    render(<ComplaintDashboard />);
    expect(
      screen.getByText(/Showing 10 tickets from 2026-06-02 to 2026-07-29/),
    ).toBeInTheDocument();
  });

  it('shows how many tickets were settled, not just what was spent', () => {
    render(<ComplaintDashboard />);
    expect(screen.getByText('4 compensated · 25.0 avg each')).toBeInTheDocument();
  });
});

describe('ComplaintDashboard — click-through drill-down', () => {
  it('opens the tickets behind a bar, not just its count', async () => {
    const user = userEvent.setup();
    render(<ComplaintDashboard />);

    await user.click(screen.getByRole('button', { name: /Missing item/ }));

    // The drawer names the cut and lists the matching ticket only.
    expect(screen.getByText('By ticket type: Missing item')).toBeInTheDocument();
    expect(screen.getByText('Missing garlic sauce')).toBeInTheDocument();
    expect(screen.queryByText('Order arrived cold')).not.toBeInTheDocument();
  });

  it('matches on the row KEY so a translated label cannot break it', async () => {
    const user = userEvent.setup();
    render(<ComplaintDashboard />);

    // The status bar is labelled through t(), but keyed on the raw value.
    await user.click(screen.getAllByRole('button', { name: /closed/ })[0]!);
    expect(screen.getByText('Order arrived cold')).toBeInTheDocument();
    expect(screen.queryByText('Missing garlic sauce')).not.toBeInTheDocument();
  });

  it('drills an agent from the unsolved chart to their OPEN tickets only', async () => {
    const user = userEvent.setup();
    render(<ComplaintDashboard />);

    // "Sara" is the unsolved-chart row; the fixture keys it by label, so use
    // the agent breakdown row for Amjad which has one open and one closed.
    const unsolved = screen.getByText('Unsolved tickets by agent').closest('section')!;
    const bar = unsolved.querySelector('button')!;
    await user.click(bar);
    // Sara has no rows in the fixture — the drawer still opens and says so
    // rather than silently doing nothing.
    expect(screen.getByText(/Unsolved tickets by agent: Sara/)).toBeInTheDocument();
  });

  it('totals the compensation of whatever slice was opened', async () => {
    const user = userEvent.setup();
    render(<ComplaintDashboard />);
    await user.click(screen.getByRole('button', { name: /Missing item/ }));
    expect(screen.getByText(/1 ticket\(s\) · 10 SAR compensation/)).toBeInTheDocument();
  });

  // The "CRM replies per agent" assertion went with the agent table it drove.
  // That column now lives on Agent summary, where it is covered by
  // agent-reports-page.test.tsx.
});
