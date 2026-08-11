import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  emptyComplaintFilters: { from: '', to: '', brand: '', area: '', city: '', store: '', phone: '' },
}));
vi.mock('../src/features/dashboard/complaints-api.js', () => api);

import { ComplaintDashboard } from '../src/features/dashboard/ComplaintDashboard.js';

const bd = (label: string, count: number) => ({ key: label, label, count });
/** A cut whose `distinct` exceeds what is shown, so the "top N of M" note renders. */
const cut = (rows: ReturnType<typeof bd>[], distinct = rows.length) => ({ rows, distinct });

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
    for (const label of ['From', 'To', 'Brand', 'Area', 'City', 'Restaurant', 'Customer mobile']) {
      expect(screen.getByText(label), `missing filter: ${label}`).toBeInTheDocument();
    }
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
