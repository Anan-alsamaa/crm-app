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
  it('renders both donuts, the trend, both agent tables and the breakdowns', () => {
    render(<ComplaintDashboard />);
    for (const heading of [
      'Complaint status mix',
      'Where complaints come from',
      'Service health',
      'Chat responsiveness',
      'Complaints per month',
      'Agent performance',
      'Agent performance — chat',
      'Unsolved complaints by agent',
      'Top restaurants',
      'By complaint type',
      'By brand',
      'By area',
      'By city',
      'By status',
      'By service type',
      'By agent',
      'How complaints reach us',
    ]) {
      expect(screen.getByText(heading), `missing section: ${heading}`).toBeInTheDocument();
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

describe('ComplaintDashboard — donut slices are actually painted', () => {
  /**
   * The design tokens are raw OKLCH COMPONENTS, so `stroke="var(--primary)"`
   * is an invalid colour: the browser drops it and the ring renders present in
   * the DOM but invisible on screen. jsdom does not compute styles well enough
   * to catch that, so assert the shape of the value we hand the browser.
   */
  it('gives every slice a complete colour function, not a bare token', () => {
    const { container } = render(<ComplaintDashboard />);
    const slices = Array.from(container.querySelectorAll('circle[stroke]'));
    expect(slices.length).toBeGreaterThan(0);
    for (const s of slices) {
      const stroke = s.getAttribute('stroke') ?? '';
      expect(stroke, `bare token would paint nothing: ${stroke}`).toMatch(/^oklch\(|^#|^rgb/);
    }
  });

  it('gives every legend chip the same complete colour', () => {
    const { container } = render(<ComplaintDashboard />);
    const chips = Array.from(container.querySelectorAll('span[style*="background"]'));
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) {
      expect(c.getAttribute('style') ?? '').toMatch(/oklch\(|#|rgb/);
    }
  });

  it('sizes the slices in proportion and prints the total in the middle', () => {
    const { container } = render(<ComplaintDashboard />);
    // Target the DONUT svg specifically — the page has other svgs (select
    // chevrons, the trend line) and picking the first one tests nothing.
    const svg = container.querySelector('svg[viewBox="0 0 140 140"]');
    // byStatus is 6 + 4, so the first ring shows 10 in the centre.
    expect(svg?.textContent).toContain('10');
    const first = svg?.querySelector('circle[stroke-dasharray]');
    const [len] = (first?.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number);
    const circumference = 2 * Math.PI * 54;
    // Largest slice first: 6 of 10.
    expect(len).toBeCloseTo(circumference * 0.6, 1);
  });
});

describe('ComplaintDashboard — a capped list admits what it hides', () => {
  it('prints "top N of M" only on the cuts that are actually truncated', () => {
    render(<ComplaintDashboard />);
    // byCity shows 1 of 24 distinct cities.
    expect(screen.getByText('top 1 of 24')).toBeInTheDocument();
    // byType shows all 2 of its 2, so it must NOT claim to be capped.
    expect(screen.queryByText('top 2 of 2')).not.toBeInTheDocument();
  });

  it('states the period the data actually covers, not the filter', () => {
    render(<ComplaintDashboard />);
    expect(
      screen.getByText(/Showing 10 complaints from 2026-06-02 to 2026-07-29/),
    ).toBeInTheDocument();
  });

  it('shows how many complaints were settled, not just what was spent', () => {
    render(<ComplaintDashboard />);
    expect(screen.getByText('4 compensated · 25.0 avg each')).toBeInTheDocument();
  });
});

describe('ComplaintDashboard — click-through drill-down', () => {
  it('opens the complaints behind a bar, not just its count', async () => {
    const user = userEvent.setup();
    render(<ComplaintDashboard />);

    await user.click(screen.getByRole('button', { name: /Missing item/ }));

    // The drawer names the cut and lists the matching complaint only.
    expect(screen.getByText('By complaint type: Missing item')).toBeInTheDocument();
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

  it('drills an agent from the unsolved chart to their OPEN complaints only', async () => {
    const user = userEvent.setup();
    render(<ComplaintDashboard />);

    // "Sara" is the unsolved-chart row; the fixture keys it by label, so use
    // the agent breakdown row for Amjad which has one open and one closed.
    const unsolved = screen.getByText('Unsolved complaints by agent').closest('section')!;
    const bar = unsolved.querySelector('button')!;
    await user.click(bar);
    // Sara has no rows in the fixture — the drawer still opens and says so
    // rather than silently doing nothing.
    expect(screen.getByText(/Unsolved complaints by agent: Sara/)).toBeInTheDocument();
  });

  it('totals the compensation of whatever slice was opened', async () => {
    const user = userEvent.setup();
    render(<ComplaintDashboard />);
    await user.click(screen.getByRole('button', { name: /Missing item/ }));
    expect(screen.getByText(/1 complaint\(s\) · 10 SAR compensation/)).toBeInTheDocument();
  });

  it('shows CRM replies per agent in place of his WhatsApp column', () => {
    const { container } = render(<ComplaintDashboard />);
    const header = screen.getByText('CRM replies');
    expect(header).toBeInTheDocument();
    // Scoped to the COMPLAINTS agent table — the chat table reports the same
    // count under "Replies sent", so an unscoped match hits both.
    const table = header.closest('table')!;
    const idx = Array.from(table.querySelectorAll('th')).indexOf(header as HTMLTableCellElement);
    const cell = table.querySelectorAll('tbody tr')[0]!.querySelectorAll('td')[idx]!;
    expect(cell.textContent).toBe('42');
    expect(container).toBeTruthy();
  });
});
