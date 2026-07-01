import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const api = vi.hoisted(() => ({
  useDashboardMetrics: vi.fn(),
}));
vi.mock('../src/features/dashboard/api.js', () => api);

import { DashboardPage } from '../src/features/dashboard/DashboardPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<DashboardPage />, { wrapper: Wrapper });
}

const fullMetrics = {
  conversationVolume: 128,
  conversationsByStatus: { open: 40, pending: 12, resolved: 60, closed: 16 },
  volumeSeries: [
    { day: '2026-06-01', count: 5 },
    { day: '2026-06-02', count: 9 },
    { day: '2026-06-03', count: 0 },
  ],
  avgResponseMinutes: 42,
  slaCompliancePct: 87,
  ticketResolutionPct: 73,
  ticketTotal: 90,
  csatAvg: 4.2,
  csatCount: 33,
  topAgents: [
    { id: 'a1', name: 'Alice', resolved: 30 },
    { id: 'a2', name: 'Bob', resolved: 18 },
  ],
  topVendors: [
    { id: 'v1', name: 'Acme', conversations: 55 },
    { id: 'v2', name: 'Globex', conversations: 22 },
  ],
};

// jsdom doesn't implement Element.scrollIntoView, which the SelectMenu listbox
// calls when it opens. Stub it so the dropdown-interaction test can run.
beforeEach(() => {
  api.useDashboardMetrics.mockReset();
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

describe('DashboardPage', () => {
  it('renders the loading skeleton while metrics load', () => {
    api.useDashboardMetrics.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    const { container } = renderPage();
    // Title toolbar always renders.
    expect(screen.getByText('Overview')).toBeInTheDocument();
    // Skeleton grid renders 5 placeholders; no stat values present.
    expect(screen.queryByText('Conversations')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.h-24').length).toBe(5);
  });

  it('renders the loading skeleton when data is missing but not loading', () => {
    api.useDashboardMetrics.mockReturnValue({ isLoading: false, isError: false, data: undefined });
    renderPage();
    expect(screen.queryByText('SLA compliance')).not.toBeInTheDocument();
    expect(screen.getByText('Overview')).toBeInTheDocument();
  });

  it('renders populated metrics, labels and formatted values', () => {
    api.useDashboardMetrics.mockReturnValue({
      isLoading: false,
      isError: false,
      data: fullMetrics,
    });
    renderPage();

    // Stat labels.
    expect(screen.getByText('Conversations')).toBeInTheDocument();
    expect(screen.getByText('Avg response')).toBeInTheDocument();
    expect(screen.getByText('SLA compliance')).toBeInTheDocument();
    expect(screen.getByText('Resolution rate')).toBeInTheDocument();
    expect(screen.getByText('CSAT')).toBeInTheDocument();

    // Formatted values.
    expect(screen.getByText('128')).toBeInTheDocument(); // conversationVolume
    expect(screen.getByText('42m')).toBeInTheDocument(); // fmtMinutes < 60
    expect(screen.getByText('87%')).toBeInTheDocument(); // fmtPct SLA
    expect(screen.getByText('73%')).toBeInTheDocument(); // fmtPct resolution
    expect(screen.getByText('4.2/5')).toBeInTheDocument(); // csatAvg

    // Card titles.
    expect(screen.getByText('Conversation volume')).toBeInTheDocument();
    expect(screen.getByText('Conversations by status')).toBeInTheDocument();
    expect(screen.getByText('Agent productivity')).toBeInTheDocument();
    expect(screen.getByText('Vendor activity')).toBeInTheDocument();

    // Status breakdown (sorted desc: resolved 60 first).
    expect(screen.getByText('resolved')).toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();

    // Rank lists.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Globex')).toBeInTheDocument();
  });

  it('formats hours and days and null metrics with an em dash', () => {
    api.useDashboardMetrics.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ...fullMetrics,
        avgResponseMinutes: 120, // -> 2.0h
        slaCompliancePct: null, // -> —
        ticketResolutionPct: null, // -> —
        csatAvg: null, // -> —
      },
    });
    renderPage();
    expect(screen.getByText('2.0h')).toBeInTheDocument();
    // Two Stat values and CSAT all render an em dash placeholder.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('formats multi-day average response time', () => {
    api.useDashboardMetrics.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { ...fullMetrics, avgResponseMinutes: 2880 }, // -> 2d
    });
    renderPage();
    expect(screen.getByText('2d')).toBeInTheDocument();
  });

  it('renders empty placeholders when series and lists are empty', () => {
    api.useDashboardMetrics.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        ...fullMetrics,
        volumeSeries: [],
        conversationsByStatus: {},
        topAgents: [],
        topVendors: [],
      },
    });
    renderPage();
    expect(screen.getByText('No activity in range.')).toBeInTheDocument();
    expect(screen.getByText('No conversations in range.')).toBeInTheDocument();
    expect(screen.getAllByText('No data yet.').length).toBe(2);
  });

  it('renders the error state and retries on click', async () => {
    const refetch = vi.fn();
    api.useDashboardMetrics.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      refetch,
    });
    renderPage();
    expect(screen.getByText('Could not load metrics')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('changes the date range via the select menu', async () => {
    api.useDashboardMetrics.mockReturnValue({
      isLoading: false,
      isError: false,
      data: fullMetrics,
    });
    renderPage();
    // Default range is 30 days.
    expect(api.useDashboardMetrics).toHaveBeenCalledWith(30);

    // SelectMenu is a custom combobox: open the trigger, then pick an option.
    await userEvent.click(screen.getByRole('combobox', { name: 'Date range' }));
    await userEvent.click(screen.getByText('Last 7 days'));
    expect(api.useDashboardMetrics).toHaveBeenLastCalledWith(7);
  });
});
