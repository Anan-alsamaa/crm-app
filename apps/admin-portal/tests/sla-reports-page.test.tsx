import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
  // The range is remembered in localStorage — clear it so one case's dates do
  // not become the next case's starting point.
  window.localStorage.clear();
  api.useSlaReports.mockReset();
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

describe('SlaReportsPage', () => {
  it('names itself while it is still loading', () => {
    /*
     * The heading used to come from a toolbar that rendered whatever the query
     * was doing. Folding that toolbar away — it carried the report's name,
     * which the tab strip above already shows as a selected pill, plus an
     * export that belongs with its filters — briefly put the name inside the
     * LOADED branch only, and a page still fetching became a spinner in an
     * unnamed rectangle.
     */
    api.useSlaReports.mockReturnValue({ isLoading: true, data: undefined });
    renderPage();
    expect(screen.getByText('Ticket deadlines')).toBeInTheDocument();
    // KPI strip / tables not rendered yet.
    expect(screen.queryByText('Tickets')).not.toBeInTheDocument();
    // Spinner is a bordered span, not an svg — assert the ROLE it exposes,
    // which is what a screen reader is told and what cannot drift with the
    // styling.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('keeps the filters on screen when a range returns nothing', () => {
    // An empty RESULT is not an empty page: the dates that got you here have to
    // stay, or there is no way to widen them.
    api.useSlaReports.mockReturnValue({
      isLoading: false,
      data: {
        tickets: [],
        agents: [],
        totals: { tickets: 0, frPct: null, resPct: null, breaches: 0 },
      },
    });
    renderPage();
    expect(screen.getAllByPlaceholderText('dd/mm/yyyy').length).toBe(2);
    expect(screen.getByText(/No tickets match these filters/)).toBeInTheDocument();
  });

  it('renders the empty state when data is missing', () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: undefined });
    renderPage();
    expect(screen.getByText('No tickets in this window')).toBeInTheDocument();
  });

  it('shows every ticket with its SLA outcome, with no view to switch', async () => {
    // The by-agent / by-ticket toggle is gone: its per-agent half was retired
    // when Agent KPI took that job, leaving a control with one working
    // position that switched nothing.
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });
    renderPage();

    // All tickets shown (no agent filter).
    expect(screen.getByText('Broken login flow')).toBeInTheDocument();
    expect(screen.getByText('Feature request')).toBeInTheDocument();
    // SLA pill states rendered.
    expect(screen.getAllByText('Met').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Breached').length).toBeGreaterThanOrEqual(1);
    // "Pending" was the FIRST-RESPONSE state, and that column is gone: a
    // ticket is raised out of a conversation that was already answered, so
    // judging its first response re-judged a reply made before it existed.
    // Only resolution is measured for tickets now.
    expect(screen.queryByText('Pending')).toBeNull();
  });

  it('narrows to an explicit date range, which beats the rolling window', async () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });
    renderPage();

    // Typed the way a person types it. The fields are dd/mm/yyyy now (Chrome
    // renders a native date input in its own locale regardless of the page),
    // while the value handed upstream is still ISO — which is what the
    // assertion below is really about.
    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '01/08/2026' } });
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: '14/08/2026' } });
    /*
     * Then COMMIT. Filters no longer write through on each keystroke — the
     * report used to re-query on every half-typed date, so a range was fetched
     * three or four times on the way to being entered. Typing moves a draft;
     * Apply is what asks the question.
     */
    fireEvent.click(screen.getByRole('button', { name: /^Apply changes$/ }));
    // The window is DERIVED from the dates, so the first argument follows
    // whatever was typed rather than being a second, independent answer.
    expect(api.useSlaReports).toHaveBeenLastCalledWith(expect.any(Number), {
      from: '2026-08-01',
      to: '2026-08-14',
    });
  });

  it('lets a quick range WRITE the two dates rather than compete with them', async () => {
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });
    renderPage();

    await userEvent.click(screen.getByRole('combobox', { name: 'Date range' }));
    await userEvent.click(screen.getByText('Last 7 days'));
    const range = api.useSlaReports.mock.calls.at(-1)?.[1] as { from: string; to: string };
    const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000;
    expect(days).toBeCloseTo(7, 0);
  });

  it('exports a CSV Excel can actually open', async () => {
    // There were two tests here, "agent-view" and "ticket-view", doing the same
    // thing: the agent view was retired long ago, so both clicked the one
    // remaining button and asserted only that SOMETHING downloaded. Neither
    // would have noticed what was actually wrong with the file.
    api.useSlaReports.mockReturnValue({ isLoading: false, data: fullReport });

    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:sla';
    }) as unknown as typeof URL.createObjectURL;
    const revokeObjectURL = vi.fn();
    URL.revokeObjectURL = revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderPage();
    await userEvent.click(screen.getByText('Export CSV (3)'));

    expect(blobs).toHaveLength(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);

    // Blob.text() is missing from the jsdom this suite runs on; FileReader is
    // the portable way in. The BOM has to be checked on the RAW BYTES — a
    // UTF-8 text decode consumes it, so reading as text and looking for U+FEFF
    // finds nothing whether or not the file has one.
    const read = <T,>(how: (fr: FileReader) => void, pick: (fr: FileReader) => T) =>
      new Promise<T>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(pick(fr));
        fr.onerror = () => reject(fr.error);
        how(fr);
      });

    const bytes = new Uint8Array(
      await read<ArrayBuffer>(
        (fr) => fr.readAsArrayBuffer(blobs[0]!),
        (fr) => fr.result as ArrayBuffer,
      ),
    );
    // A UTF-8 BOM, because without one Excel reads the file as the local
    // codepage and every Arabic subject and agent name arrives as mojibake.
    // This page's own writer emitted none, and nobody found out until somebody
    // opened a file.
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const text = await read<string>(
      (fr) => fr.readAsText(blobs[0]!),
      (fr) => String(fr.result),
    );
    const lines = text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe('Ticket,Priority,Status,Agent,Resolution,1st reply,Ticket id');
    // A subject containing a comma and quotes survives the round trip instead
    // of shifting every later column one place left.
    expect(lines.join('\n')).toContain('"Invoice question, comma ""quoted"""');
    clickSpy.mockRestore();
  });

  it('offers no export when there is nothing to export, and says what to do', () => {
    /*
     * The export used to sit in the toolbar, always rendered and disabled when
     * the query returned nothing. It lives in the filter bar now — beside the
     * controls whose result it writes — so with no data there is no bar and no
     * button.
     *
     * That is the honest shape: a disabled button tells a reader the feature
     * exists, which they can see from any other range, whereas the empty state
     * tells them the one thing they can act on. What matters is that the page
     * does not simply go blank, so this asserts the instruction is there.
     */
    api.useSlaReports.mockReturnValue({ isLoading: false, data: undefined });
    renderPage();
    expect(screen.queryByText(/Export CSV/)).not.toBeInTheDocument();
    expect(screen.getByText('No tickets in this window')).toBeInTheDocument();
    expect(screen.getByText(/Widen the date range/)).toBeInTheDocument();
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
