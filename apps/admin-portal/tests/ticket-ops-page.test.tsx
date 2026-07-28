import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Mirror i18next: return the defaultValue and interpolate {{param}}.
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
  }),
}));

const api = vi.hoisted(() => ({ useTicketOps: vi.fn() }));
vi.mock('../src/features/ticket-ops/api.js', () => api);

const commerceMock = vi.hoisted(() => ({
  commerce: { getOrders: vi.fn(), getOrder: vi.fn() },
}));
vi.mock('../src/lib/commerce-client.js', () => commerceMock);

import { TicketOpsPage } from '../src/features/ticket-ops/TicketOpsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<TicketOpsPage />, { wrapper: Wrapper });
}

/** Read the KPI tiles as `{ label: value }` (value div, then label div). */
function tiles(container: HTMLElement, valueClass: string) {
  const out: Record<string, string> = {};
  container.querySelectorAll(valueClass).forEach((v) => {
    const label = v.nextElementSibling?.textContent?.trim();
    if (label) out[label] = v.textContent?.trim() ?? '';
  });
  return out;
}
const kpis = (c: HTMLElement) => tiles(c, '.text-4xl');
const timings = (c: HTMLElement) => tiles(c, '.text-3xl');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'r',
    subject: 'Subject',
    status: 'open',
    priority: 'medium',
    agentId: 'u1',
    agentName: 'Ann Lee',
    teamName: 'Tier 1',
    created: '2026-06-01T08:30:00.000Z',
    firstRespondedAt: null,
    resolvedAt: null,
    closedAt: null,
    responseMinutes: null,
    resolutionMinutes: null,
    overdue: false,
    ageHours: 5,
    contactName: 'Dana Ali',
    customerId: null,
    yijiVendorId: null,
    ...over,
  };
}

const rows = [
  row({
    id: 't1',
    subject: 'Late delivery',
    status: 'open',
    priority: 'urgent',
    firstRespondedAt: '2026-06-01T09:00:00.000Z',
    responseMinutes: 30,
    overdue: true,
    // Only this row has commerce ids, so only it can expand to an order.
    customerId: 'cust-9',
    yijiVendorId: 'v-7',
  }),
  row({
    id: 't2',
    subject: 'Refund request',
    status: 'pending',
    priority: 'high',
    agentId: null,
    agentName: 'Unassigned',
    teamName: '—',
    contactName: '—',
    ageHours: 30,
  }),
  row({
    id: 't3',
    subject: 'Wrong item shipped',
    status: 'resolved',
    priority: 'low',
    agentId: 'u2',
    agentName: 'Bo Ray',
    resolvedAt: '2026-06-02T10:00:00.000Z',
    resolutionMinutes: 180,
    ageHours: null,
  }),
  row({
    id: 't4',
    subject: 'App crash on checkout',
    status: 'closed',
    priority: 'medium',
    agentId: 'u2',
    agentName: 'Bo Ray',
    created: null,
    closedAt: '2026-06-03T10:00:00.000Z',
    ageHours: null,
  }),
];

const report = {
  rows,
  totals: { total: 4, open: 2, pending: 1, resolved: 1, closed: 1, overdue: 1, unassigned: 1 },
  byStatus: [
    { key: 'open', count: 1 },
    { key: 'pending', count: 1 },
    { key: 'resolved', count: 1 },
    { key: 'closed', count: 1 },
  ],
  byPriority: [
    { key: 'urgent', count: 1 },
    { key: 'high', count: 1 },
    { key: 'medium', count: 1 },
    { key: 'low', count: 1 },
  ],
  timing: { medianResponseMin: 45, medianResolutionMin: 300, avgResolutionMin: 2880 },
  agents: [
    {
      agentId: null,
      agentName: 'Unassigned',
      total: 1,
      open: 1,
      overdue: 1,
      resolved: 0,
      avgResolutionMin: null,
    },
    {
      agentId: 'u1',
      agentName: 'Ann Lee',
      total: 1,
      open: 1,
      overdue: 0,
      resolved: 0,
      avgResolutionMin: null,
    },
    {
      agentId: 'u2',
      agentName: 'Bo Ray',
      total: 2,
      open: 0,
      overdue: 0,
      resolved: 2,
      avgResolutionMin: 180,
    },
  ],
};

beforeEach(() => {
  api.useTicketOps.mockReset();
  commerceMock.commerce.getOrders.mockReset();
  commerceMock.commerce.getOrder.mockReset();
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

describe('TicketOpsPage', () => {
  it('renders the spinner while the report loads', () => {
    api.useTicketOps.mockReturnValue({ isLoading: true, data: undefined });
    const { container } = renderPage();

    expect(screen.getByText('Ticket report')).toBeInTheDocument();
    expect(screen.queryByText('Ticket register')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders the empty state for an empty window and for missing data', () => {
    api.useTicketOps.mockReturnValue({
      isLoading: false,
      data: { ...report, rows: [], totals: { ...report.totals, total: 0 } },
    });
    const { unmount } = renderPage();
    expect(screen.getByText('No tickets in this window')).toBeInTheDocument();
    unmount();

    api.useTicketOps.mockReturnValue({ isLoading: false, data: undefined });
    renderPage();
    expect(screen.getByText('No tickets in this window')).toBeInTheDocument();
  });

  it('renders the backlog KPI tiles from the report totals', () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    const { container } = renderPage();

    expect(api.useTicketOps).toHaveBeenCalledWith(30); // default window
    expect(kpis(container)).toEqual({
      Tickets: '4',
      'Open backlog': '2',
      Overdue: '1',
      Unassigned: '1',
      Resolved: '1',
      Closed: '1',
    });
  });

  it('formats the lifecycle timings in minutes, hours and days', () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    const { container } = renderPage();

    expect(timings(container)).toEqual({
      'Median 1st response': '45m',
      'Median resolution': '5.0h',
      'Avg resolution': '2.0d',
    });
  });

  it('shows an em dash for timings that have no sample yet', () => {
    api.useTicketOps.mockReturnValue({
      isLoading: false,
      data: {
        ...report,
        timing: { medianResponseMin: null, medianResolutionMin: null, avgResolutionMin: null },
      },
    });
    const { container } = renderPage();
    expect(timings(container)['Median resolution']).toBe('—');
  });

  it('renders the status and priority breakdowns with counts', () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    renderPage();

    expect(screen.getByText('By status')).toBeInTheDocument();
    expect(screen.getByText('By priority')).toBeInTheDocument();
    // Each breakdown row shows its count next to a percentage of the total.
    expect(screen.getAllByText('25%')).toHaveLength(8); // 4 statuses + 4 priorities
  });

  it('renders the agent workload table, flagging agents that carry overdue work', () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    const { container } = renderPage();

    const agentTable = container.querySelectorAll('table')[0]!;
    const bodyRows = agentTable.querySelectorAll('tbody tr');
    expect(bodyRows).toHaveLength(3);
    expect(within(bodyRows[0] as HTMLElement).getByText('Unassigned')).toBeInTheDocument();
    // Bo Ray's average resolution renders through fmtDuration (180m -> 3.0h).
    expect(within(bodyRows[2] as HTMLElement).getByText('3.0h')).toBeInTheDocument();
    // Agents with no resolved ticket show an em dash instead of a duration.
    expect(within(bodyRows[1] as HTMLElement).getByText('—')).toBeInTheDocument();
  });

  it('renders every ticket in the register with its age or an Overdue flag', () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    const { container } = renderPage();

    expect(screen.getByText('Late delivery')).toBeInTheDocument();
    expect(screen.getByText('Refund request')).toBeInTheDocument();
    expect(screen.getByText('Wrong item shipped')).toBeInTheDocument();
    expect(screen.getByText('App crash on checkout')).toBeInTheDocument();

    const register = within(container.querySelectorAll('table')[1] as HTMLElement);
    // Overdue rows replace the age with the Overdue flag; others format the age.
    expect(register.getByText('Overdue')).toBeInTheDocument(); // t1
    expect(register.getByText('1.3d')).toBeInTheDocument(); // t2, 30h old
    // First response duration for the only responded ticket.
    expect(register.getByText('30m')).toBeInTheDocument();
    // Resolved/closed tickets have no age, and t3/t4 never got a first response.
    expect(register.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('renders a status filter tab per present status, with live counts', () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    renderPage();

    expect(screen.getByRole('button', { name: 'All 4' })).toBeInTheDocument();
    for (const status of ['open', 'pending', 'resolved', 'closed']) {
      expect(screen.getByRole('button', { name: `${status} 1` })).toBeInTheDocument();
    }
    // `new` has no tickets in this window, so it gets no tab.
    expect(screen.queryByRole('button', { name: /^new/ })).not.toBeInTheDocument();
  });

  it('filters the register when a status tab is clicked, and restores it via All', async () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'pending 1' }));
    expect(screen.getByText('Refund request')).toBeInTheDocument();
    expect(screen.queryByText('Late delivery')).not.toBeInTheDocument();
    expect(screen.queryByText('Wrong item shipped')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All 4' }));
    expect(screen.getByText('Late delivery')).toBeInTheDocument();
    expect(screen.getByText('Wrong item shipped')).toBeInTheDocument();
  });

  it('sorts the register when a column header is clicked', async () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    const { container } = renderPage();
    const subjects = () =>
      Array.from(container.querySelectorAll('table')[1]!.querySelectorAll('tbody tr')).map(
        (tr) => tr.querySelector('td div div')?.textContent?.trim() ?? '',
      );

    expect(subjects()[0]).toBe('Late delivery'); // unsorted -> source order

    await userEvent.click(screen.getByRole('button', { name: 'Ticket' }));
    expect(subjects()[0]).toBe('App crash on checkout'); // asc by subject
    await userEvent.click(screen.getByRole('button', { name: 'Ticket' }));
    expect(subjects()[0]).toBe('Wrong item shipped'); // desc by subject
  });

  it('paginates the register beyond ten rows', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      row({ id: `p${i}`, subject: `Paged ticket ${i}` }),
    );
    api.useTicketOps.mockReturnValue({
      isLoading: false,
      data: { ...report, rows: many, totals: { ...report.totals, total: 12 } },
    });
    renderPage();

    expect(screen.getByText('Paged ticket 0')).toBeInTheDocument();
    expect(screen.queryByText('Paged ticket 11')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '2' }));
    expect(screen.getByText('Paged ticket 11')).toBeInTheDocument();
    expect(screen.queryByText('Paged ticket 0')).not.toBeInTheDocument();
  });

  it('only offers the order drill-down for tickets with commerce ids', () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    renderPage();
    // Only t1 carries customerId + yijiVendorId.
    expect(screen.getAllByRole('button', { name: 'View order' })).toHaveLength(1);
  });

  it('expands a ticket to its linked Yiji order', async () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    commerceMock.commerce.getOrders.mockResolvedValue([{ orderId: 'o-9' }]);
    commerceMock.commerce.getOrder.mockResolvedValue({
      orderId: 'o-9',
      status: 'out_for_delivery',
      deliveryType: 'in_delivery',
      total: 145.5,
      currency: 'SAR',
      brandName: 'La Casa',
      restaurantName: 'Riyadh — Masief',
      items: [{ sku: 's1', qty: 2, name: 'Pasta', price: 50, category: 'Main' }],
    });

    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'View order' }));

    const card = (await screen.findByText('#o-9')).closest('div.rounded-2xl') as HTMLElement;
    expect(commerceMock.commerce.getOrders).toHaveBeenCalledWith('v-7', 'cust-9', { limit: 1 });
    expect(commerceMock.commerce.getOrder).toHaveBeenCalledWith('v-7', 'o-9');
    expect(card.textContent).toContain('Out For Delivery'); // status, titleized
    expect(card.textContent).toContain('In Delivery'); // deliveryType, titleized
    expect(card.textContent).toContain('La Casa — Riyadh — Masief');
    expect(card.textContent).toContain('2×');
    expect(card.textContent).toContain('Pasta');
  });

  it('tells the user when the linked customer has no order', async () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    commerceMock.commerce.getOrders.mockResolvedValue([]);

    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'View order' }));

    expect(await screen.findByText('No linked order for this customer.')).toBeInTheDocument();
    expect(commerceMock.commerce.getOrder).not.toHaveBeenCalled();
  });

  it('re-queries when the date range changes', async () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    renderPage();

    await userEvent.click(screen.getByRole('combobox', { name: 'Date range' }));
    await userEvent.click(screen.getByText('Last 7 days'));
    expect(api.useTicketOps).toHaveBeenLastCalledWith(7);
  });

  it('exports the register as CSV and disables the button without data', async () => {
    api.useTicketOps.mockReturnValue({ isLoading: false, data: undefined });
    const { unmount } = renderPage();
    expect(screen.getByText('Export CSV').closest('button')).toBeDisabled();
    unmount();

    api.useTicketOps.mockReturnValue({ isLoading: false, data: report });
    const createObjectURL = vi.fn(() => 'blob:ops');
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderPage();
    await userEvent.click(screen.getByText('Export CSV'));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });
});
