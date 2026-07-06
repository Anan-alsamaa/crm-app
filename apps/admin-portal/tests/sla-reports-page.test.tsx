import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Return the defaultValue and interpolate {{param}} placeholders like real
    // i18next (e.g. 'Last {{days}} days' + { days: 7 } → 'Last 7 days'), so
    // interpolated labels render their concrete text.
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

const api = vi.hoisted(() => ({
  useSlaReports: vi.fn(),
}));
vi.mock('../src/features/sla-reports/api.js', () => api);

import { SlaReportsPage } from '../src/features/sla-reports/SlaReportsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<SlaReportsPage />, { wrapper: Wrapper });
}

const cell = (state: 'met' | 'breached' | 'pending' | 'na') => ({
  state,
  dueAt: '2026-06-01T10:00:00.000Z',
  doneAt: state === 'met' || state === 'breached' ? '2026-06-01T09:00:00.000Z' : null,
});

// Two agents, several tickets — enough to exercise every KPI tone branch,
// both tables, drill-down filtering and CSV export for both views.
const fullReport = {
  tickets: [
    {
      id: 't1',
      subject: 'Broken login flow',
      priority: 'urgent',
      status: 'open',
      agentId: 'a1',
      agentName: 'Alice',
      created: '2026-06-01T08:00:00.000Z',
      firstResponse: cell('met'),
      resolution: cell('breached'),
      responseMinutes: 12,
    },
    {
      id: 't2',
      subject: 'Invoice question, comma "quoted"',
      priority: 'low',
      status: 'closed',
      agentId: 'a1',
      agentName: 'Alice',
      created: '2026-06-02T08:00:00.000Z',
      firstResponse: cell('pending'),
      resolution: cell('na'),
      responseMinutes: null,
    },
    {
      id: 't3',
      subject: 'Feature request',
      priority: 'medium',
      status: 'new',
      agentId: 'a2',
      agentName: 'Bob',
      created: '2026-06-03T08:00:00.000Z',
      firstResponse: cell('breached'),
      resolution: cell('met'),
      responseMinutes: 95,
    },
  ],
  agents: [
    {
      agentId: 'a1',
      agentName: 'Alice',
      tickets: 2,
      frMet: 1,
      frBreached: 0,
      frPending: 1,
      frPct: 100,
      resMet: 0,
      resBreached: 1,
      resPending: 0,
      resPct: 0,
      avgResponseMin: 12,
      breaches: 1,
    },
    {
      agentId: 'a2',
      agentName: 'Bob',
      tickets: 1,
      frMet: 0,
      frBreached: 1,
      frPending: 0,
      frPct: 0,
      resMet: 1,
      resBreached: 0,
      resPending: 0,
      resPct: 100,
      avgResponseMin: 95,
      breaches: 1,
    },
  ],
  totals: { tickets: 3, frPct: 50, resPct: 50, breaches: 2 },
};

// jsdom lacks scrollIntoView, which SelectMenu's listbox calls on open.
beforeEach(() => {
  api.useSlaReports.mockReset();
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

describe('SlaReportsPage', () => {
  it('renders the spinner while loading', () => {
    api.useSlaReports.mockReturnValue({ isLoading: true, data: undefined });
    const { container } = renderPage();
    expect(screen.getByText('SLA reports')).toBeInTheDocument();
    // KPI strip / tables not rendered yet.
    expect(screen.queryByText('Tickets')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders the empty state when there are no tickets', () => {
    api.useSlaReports.mockReturnValue({
      isLoading: false,
      data: {
        tickets: [],
        agents: [],
        totals: { tickets: 0, frPct: null, resPct: null, breaches: 0 },
      },
    });
    renderPage();
    expect(screen.getByText('No tickets in this window')).toBeInTheDocument();
  });

  it('renders the empty state when data is missing', () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: undefined });
    renderPage();
    expect(screen.getByText('No tickets in this window')).toBeInTheDocument();
  });

  it('renders KPI strip and the agent table by default', () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });
    renderPage();

    // Default range is 30 days.
    expect(api.useSlaReports).toHaveBeenCalledWith(30);

    // KPI labels + formatted values.
    expect(screen.getByText('First-response SLA')).toBeInTheDocument();
    expect(screen.getByText('Resolution SLA')).toBeInTheDocument();
    // "Breaches" appears both as a KPI label and a table header.
    expect(screen.getAllByText('Breaches').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('50%').length).toBeGreaterThanOrEqual(2); // frPct + resPct

    // Agent rows.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Click an agent to see their tickets.')).toBeInTheDocument();
  });

  it('switches to the ticket view via the toolbar toggle', async () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });
    renderPage();

    await userEvent.click(screen.getByText('By ticket'));

    // All tickets shown (no agent filter).
    expect(screen.getByText('Broken login flow')).toBeInTheDocument();
    expect(screen.getByText('Feature request')).toBeInTheDocument();
    // SLA pill states rendered.
    expect(screen.getAllByText('Met').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Breached').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('drills from an agent into their filtered tickets and clears the filter', async () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });
    renderPage();

    // Click Alice's row -> ticket view filtered to Alice (2 tickets).
    await userEvent.click(screen.getByText('Alice'));
    expect(screen.getByText('Broken login flow')).toBeInTheDocument();
    expect(screen.getByText('Invoice question, comma "quoted"')).toBeInTheDocument();
    expect(screen.queryByText('Feature request')).not.toBeInTheDocument();

    // The active agent filter chip shows the agent name.
    const chip = screen.getByRole('button', { name: /Alice/ });
    expect(chip).toBeInTheDocument();

    // Clear the agent chip -> back to the agent table.
    await userEvent.click(chip);
    expect(screen.getByText('Click an agent to see their tickets.')).toBeInTheDocument();
  });

  it('returns to the agent view via the toggle after drilling in', async () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });
    renderPage();

    await userEvent.click(screen.getByText('Bob'));
    expect(screen.getByText('Feature request')).toBeInTheDocument();

    // Toolbar "By agent" toggle also resets the agent filter.
    await userEvent.click(screen.getByText('By agent'));
    expect(screen.getByText('Click an agent to see their tickets.')).toBeInTheDocument();
  });

  it('changes the date range through the SelectMenu combobox', async () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });
    renderPage();

    await userEvent.click(screen.getByRole('combobox', { name: 'Date range' }));
    await userEvent.click(screen.getByText('Last 7 days'));
    expect(api.useSlaReports).toHaveBeenLastCalledWith(7);
  });

  it('exports the agent-view CSV', async () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });

    const createObjectURL = vi.fn(() => 'blob:sla');
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

  it('exports the ticket-view CSV', async () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });

    const createObjectURL = vi.fn(() => 'blob:sla');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderPage();
    await userEvent.click(screen.getByText('By ticket'));
    await userEvent.click(screen.getByText('Export CSV'));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it('disables Export CSV while there is no data', () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: undefined });
    renderPage();
    expect(screen.getByText('Export CSV').closest('button')).toBeDisabled();
  });

  it('formats null / high / low percentages and minute values', () => {
    // Craft a report that hits every fmt/tone branch:
    //  - null frPct -> "—" + muted tone
    //  - high resPct (>=90) -> success tone
    //  - avg response >= 60 -> hours format ("1.6h")
    //  - avg response < 60 -> minutes format ("12m")
    api.useSlaReports.mockReturnValue({
      isLoading: false,
      data: {
        ...fullReport,
        totals: { tickets: 3, frPct: null, resPct: 95, breaches: 0 },
        agents: [
          { ...fullReport.agents[0]!, frPct: null, resPct: 95, avgResponseMin: 12, breaches: 0 },
          { ...fullReport.agents[1]!, frPct: 80, resPct: 40, avgResponseMin: 96, breaches: 3 },
        ],
      },
    });
    renderPage();

    // null percentage renders an em dash somewhere (KPI + agent cell).
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    // 95% high tone value present.
    expect(screen.getAllByText('95%').length).toBeGreaterThanOrEqual(1);
    // Minutes and hours formatting.
    expect(screen.getByText('12m')).toBeInTheDocument();
    expect(screen.getByText('1.6h')).toBeInTheDocument();
  });

  it('renders the unassigned agent bucket', async () => {
    api.useSlaReports.mockReturnValue({
      isLoading: false,
      data: {
        tickets: [
          {
            id: 'u1',
            subject: 'Orphan ticket',
            priority: 'high',
            status: 'pending',
            agentId: null,
            agentName: 'Unassigned',
            created: '2026-06-04T08:00:00.000Z',
            firstResponse: cell('na'),
            resolution: cell('pending'),
            responseMinutes: null,
          },
        ],
        agents: [
          {
            agentId: null,
            agentName: 'Unassigned',
            tickets: 1,
            frMet: 0,
            frBreached: 0,
            frPending: 0,
            frPct: null,
            resMet: 0,
            resBreached: 0,
            resPending: 1,
            resPct: null,
            avgResponseMin: null,
            breaches: 0,
          },
        ],
        totals: { tickets: 1, frPct: null, resPct: null, breaches: 0 },
      },
    });
    renderPage();

    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    // Drilling into an agentId:null row should still work.
    await userEvent.click(screen.getByText('Unassigned'));
    expect(screen.getByText('Orphan ticket')).toBeInTheDocument();
  });
});
