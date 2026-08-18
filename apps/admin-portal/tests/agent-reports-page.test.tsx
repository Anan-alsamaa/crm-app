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

const api = vi.hoisted(() => ({
  useAgentReportData: vi.fn(),
  useTicketOrders: vi.fn(),
}));
vi.mock('../src/features/report-exports/api.js', () => api);

/**
 * The store master the Complaints report joins against. A REAL index (not a
 * stub) so the join under test is the one that ships — including the
 * `store_code` tier that rescues a branch whose name drifted.
 */
const storesApi = vi.hoisted(() => ({ useStoreIndex: vi.fn() }));
vi.mock('../src/features/restaurants/api.js', () => storesApi);

// export.ts / xlsx.ts stay REAL: clicking "Export to Excel" must actually build
// a workbook, which is the behaviour worth asserting.
import {
  AgentReportsPage,
  type ReportKind,
} from '../src/features/report-exports/AgentReportsPage.js';
import { TICKET_COLUMN_KEYS } from '../src/features/report-exports/export.js';
import { buildStoreIndex } from '@yiji/shared-types';

function renderPage(which: ReportKind = 'tickets') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<AgentReportsPage report={which} />, { wrapper: Wrapper });
}

/** Read the KPI tiles as `{ label: value }` (value div, then label div). */
function kpis(container: HTMLElement) {
  const out: Record<string, string> = {};
  // KPI numerals standardized to text-4xl across all report pages (this page
  // was the one holdout at 3xl) — consistent component vocabulary.
  container.querySelectorAll('.text-4xl').forEach((v) => {
    const label = v.nextElementSibling?.textContent?.trim();
    if (label) out[label] = v.textContent?.trim() ?? '';
  });
  return out;
}

/** Capture what `downloadWorkbook` hands to the browser. */
function captureDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  URL.createObjectURL = vi.fn((b: Blob) => {
    blobs.push(b);
    return 'blob:report';
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return { blobs, names, restore: () => clickSpy.mockRestore() };
}

const tickets = [
  {
    id: 't1',
    subject: 'Late delivery',
    status: 'open',
    priority: 'urgent',
    contactId: 'c1',
    contactName: 'Dana Ali',
    contactEmail: 'dana@example.com',
    contactPhone: '+971500000000',
    agentName: 'Ann Lee',
    createdAt: '2026-06-01T08:00:00.000Z',
    firstResponseMinutes: 12,
    firstResponseState: 'met' as const,
    resolutionMinutes: 90.4,
    resolutionState: 'breached' as const,
  },
  {
    id: 't2',
    subject: 'Refund request',
    status: 'pending',
    priority: 'low',
    contactId: 'c2',
    // No name/phone/email -> the contact cell falls back to an em dash.
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    agentName: 'Unassigned',
    createdAt: '2026-06-02T08:00:00.000Z',
    firstResponseMinutes: null,
    firstResponseState: 'pending' as const,
    resolutionMinutes: null,
    resolutionState: 'na' as const,
  },
  {
    id: 't3',
    subject: 'Wrong item shipped',
    status: 'closed',
    priority: 'medium',
    contactId: null,
    contactName: '',
    contactEmail: '',
    contactPhone: '+971511111111',
    agentName: 'Bo Ray',
    createdAt: '2026-06-03T08:00:00.000Z',
    firstResponseMinutes: 125,
    firstResponseState: 'breached' as const,
    resolutionMinutes: 300,
    resolutionState: 'met' as const,
  },
];

const agents = [
  {
    agentId: 'u1',
    agentName: 'Ann Lee',
    tickets: 2,
    responded: 2,
    avgFirstResponseMin: 12.4,
    firstResponsePct: 66.6,
    csatCount: 3,
    csatAvg: 4.26,
    missed: 0,
    offered: 2,
    chats: 4,
    noReply: 1,
    commonTaken: 2,
    avgFirstResponseSec: 125,
    avgTimeToSolveSec: 7300,
    inTimePct: 85.4,
  },
  {
    agentId: null,
    agentName: 'Unassigned',
    tickets: 1,
    responded: 0,
    avgFirstResponseMin: null,
    firstResponsePct: null,
    csatCount: 0,
    csatAvg: null,
    missed: 0,
    offered: 0,
    chats: 0,
    noReply: 0,
    commonTaken: 0,
    avgFirstResponseSec: null,
    avgTimeToSolveSec: null,
    inTimePct: null,
  },
];

// 16 days so the by-day preview (last 14) has to truncate.
const byDay = Array.from({ length: 16 }, (_, i) => ({
  day: `2026-06-${String(i + 1).padStart(2, '0')}`,
  total: i === 0 ? 1 : 2,
  byStatus: i === 0 ? { open: 1 } : { open: 1, closed: 1 },
}));

const conversations = {
  rows: [
    {
      id: 'c1',
      status: 'open',
      priority: 'urgent',
      agentName: 'Ann Lee',
      createdAt: '2026-06-01T08:00:00.000Z',
      lastMessageAt: null,
    },
  ],
  byStatus: [
    { key: 'open', count: 20 },
    { key: 'closed', count: 11 },
  ],
  byPriority: [
    { key: 'urgent', count: 18 },
    { key: 'low', count: 13 },
  ],
  byDay,
  statuses: ['closed', 'open'],
  total: 31,
};

/**
 * Complaint rows as `api.ts` hands them over: store columns still blank, the
 * branch name straight off the stored order snapshot. The page does the join.
 */
const complaints = [
  {
    id: 'k1',
    date: '2026-03-14',
    year: 2026,
    month: 3,
    week: 11,
    day: 14,
    time: '19:11',
    chain: '',
    area: '',
    brand: 'Casa Pasta',
    city: '',
    // The master spells this "LCP-006 Panorama Mall RYD" — only the code tier
    // resolves it. Real case from the operations complaints history.
    restaurantName: 'LCP-006 Panorama Mall',
    storeCode: '',
    yijiRestaurantId: '',
    storeMapped: false,
    serviceType: 'Delivery',
    complaintType: 'Missing item',
    customerName: '',
    customerMobile: '0500000000',
    complaintDescription: 'One pasta missing',
    responseDesc: 'Apologised, coupon issued',
    complaintSource: 'WeCare Channels',
    orderAmount: 102.85,
    orderNumber: '946641',
    communicationMethod: 'Comp. WhatsApp',
    couponCode: 'OPS - 46',
    couponValue: 25,
    couponPercent: null,
    complaintStatus: 'closed',
    agent: 'Amjad',
    compensation: 'Compensated',
  },
  {
    id: 'k2',
    date: '2026-03-15',
    year: 2026,
    month: 3,
    week: 11,
    day: 15,
    time: '09:02',
    chain: '',
    area: '',
    brand: 'Chick N Dip',
    city: '',
    // No such store in the master — must stay visibly unmapped.
    restaurantName: 'CND-009 Nakhil Mall',
    storeCode: '',
    yijiRestaurantId: '',
    storeMapped: false,
    serviceType: 'Pickup',
    complaintType: 'Accuracy',
    customerName: '',
    customerMobile: '0511111111',
    complaintDescription: 'Wrong item',
    responseDesc: '',
    complaintSource: 'Comp. WhatsApp',
    orderAmount: null,
    orderNumber: '',
    communicationMethod: 'Comp. WhatsApp',
    couponCode: '',
    couponValue: null,
    couponPercent: null,
    complaintStatus: 'open',
    agent: 'Ali',
    compensation: 'Not Compensated',
  },
];

const data = {
  tickets,
  complaints,
  complaintFieldsAvailable: true,
  agents,
  conversations,
  csatOverall: { avg: 4.25, count: 8 },
  generatedAt: '2026-06-04T10:00:00.000Z',
};

const ok = { isLoading: false, isError: false, data };

const PANORAMA = {
  id: 's1',
  code: 'LCP-006',
  name: 'Panorama Mall RYD',
  city: 'Riyadh',
  areaManager: "Mo'men Elsharkasy",
  chainManager: 'Medhat Sayed',
  brandCode: 'LCP',
  brandName: 'Casa Pasta',
  brandYijiName: 'La Casa Pasta',
  yijiRestaurantId: null,
};

beforeEach(() => {
  // The column order is persisted, so without this one test's arrangement
  // leaks into the next and the failures look like product bugs.
  localStorage.clear();
  api.useAgentReportData.mockReset();
  api.useTicketOrders.mockReset();
  api.useTicketOrders.mockReturnValue({ data: undefined, isFetching: false });
  storesApi.useStoreIndex.mockReset();
  storesApi.useStoreIndex.mockReturnValue({
    index: buildStoreIndex([PANORAMA]),
    isLoading: false,
    count: 1,
  });
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

describe('AgentReportsPage — shell', () => {
  it('renders the per-report title and subtitle', () => {
    api.useAgentReportData.mockReturnValue(ok);
    renderPage('agents');
    expect(screen.getAllByText('Agent KPI').length).toBeGreaterThanOrEqual(1);
    // The subtitle names the OBJECT it counts. Three surfaces report response
    // times and their numbers cannot agree — tickets and chats are different
    // things — so each says which it measures and where the others live.
    expect(screen.getByText(/One row per agent, over TICKETS/)).toBeInTheDocument();
    expect(screen.getByText(/Agent performance/)).toBeInTheDocument();
  });

  it('renders skeletons while the report loads', () => {
    api.useAgentReportData.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    const { container } = renderPage();
    expect(screen.getAllByText('Tickets').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.animate-shimmer').length).toBeGreaterThanOrEqual(5);
  });

  it('renders an error state when the query fails', () => {
    api.useAgentReportData.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    renderPage();
    expect(screen.getByText('Could not load report data')).toBeInTheDocument();
  });

  it('renders the empty state per report kind', () => {
    const empty = {
      isLoading: false,
      isError: false,
      data: { ...data, tickets: [], agents: [], conversations: { ...conversations, total: 0 } },
    };
    for (const kind of ['tickets', 'agents', 'conversations'] as ReportKind[]) {
      api.useAgentReportData.mockReturnValue(empty);
      const { unmount } = renderPage(kind);
      expect(screen.getByText('No data in this window')).toBeInTheDocument();
      unmount();
    }
  });

  it('renders the KPI strip, counting only real (assigned) agents', () => {
    api.useAgentReportData.mockReturnValue(ok);
    const { container } = renderPage();
    expect(kpis(container)).toEqual({
      Tickets: '3',
      Conversations: '31',
      Agents: '1', // the Unassigned bucket is not an agent
      'CSAT avg': '4.25',
    });
  });

  it('re-queries when the date range changes', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    renderPage();
    expect(api.useAgentReportData).toHaveBeenCalledWith(30, {
      unassigned: 'Unassigned',
      noSubject: '(no subject)',
    });

    await userEvent.click(screen.getByRole('combobox', { name: 'Date range' }));
    await userEvent.click(screen.getByText('Last 7 days'));
    expect(api.useAgentReportData).toHaveBeenLastCalledWith(7, expect.anything());
  });
});

describe('AgentReportsPage — tickets report', () => {
  it('renders a row per ticket with SLA pills and contact fallbacks', () => {
    api.useAgentReportData.mockReturnValue(ok);
    const { container } = renderPage('tickets');

    const body = within(container.querySelector('tbody') as HTMLElement);
    expect(body.getByText('Late delivery')).toBeInTheDocument();
    expect(body.getByText('Refund request')).toBeInTheDocument();
    expect(body.getByText('Dana Ali')).toBeInTheDocument();
    // t3 has no name/email, so the phone is used; t2 has nothing -> em dash.
    expect(body.getByText('+971511111111')).toBeInTheDocument();
    expect(body.getAllByText('—').length).toBeGreaterThanOrEqual(2);

    // Minutes format: <60 as minutes, >=60 as hours; resolution is rounded.
    expect(body.getByText('12m')).toBeInTheDocument();
    expect(body.getByText('2.1h')).toBeInTheDocument(); // 125 min
    expect(body.getByText('90')).toBeInTheDocument(); // 90.4 min, rounded

    // SLA outcome pills ('na' renders as an em dash instead of a pill).
    expect(body.getByText('met')).toBeInTheDocument();
    expect(body.getByText('breached')).toBeInTheDocument();
    // 'pending' is both t2's status and its first-response SLA outcome.
    expect(body.getAllByText('pending')).toHaveLength(2);
  });

  it('sorts the ticket table by a column header', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const { container } = renderPage('tickets');
    const firstSubject = () => container.querySelector('tbody tr td')?.textContent?.trim() ?? '';

    expect(firstSubject()).toBe('Late delivery');
    await userEvent.click(screen.getByRole('button', { name: 'Subject' }));
    expect(firstSubject()).toBe('Late delivery'); // 'Late…' < 'Refund…' < 'Wrong…'
    await userEvent.click(screen.getByRole('button', { name: 'Subject' }));
    expect(firstSubject()).toBe('Wrong item shipped');
  });

  it('opens the Columns picker and toggles a column out of the export', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    renderPage('tickets');
    const total = TICKET_COLUMN_KEYS.length;

    const picker = screen.getByRole('button', { name: `Columns ${total}/${total}` });
    expect(picker).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(picker);
    expect(screen.getByText('Rearrange columns')).toBeInTheDocument();

    const subjectBox = screen.getByLabelText('Subject');
    expect(subjectBox).toBeChecked();
    await userEvent.click(subjectBox);
    expect(subjectBox).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: `Columns ${total - 1}/${total}` }),
    ).toBeInTheDocument();

    // The "All" shortcut restores the full selection.
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('button', { name: `Columns ${total}/${total}` })).toBeInTheDocument();
  });

  it('exports a real .xlsx workbook containing only the selected columns', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const dl = captureDownloads();
    renderPage('tickets');
    const total = TICKET_COLUMN_KEYS.length;

    await userEvent.click(screen.getByRole('button', { name: `Columns ${total}/${total}` }));
    await userEvent.click(screen.getByLabelText('Subject'));
    await userEvent.click(screen.getByText('Export to Excel'));

    expect(dl.blobs).toHaveLength(1);
    expect(dl.blobs[0]!.type).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(dl.blobs[0]!.size).toBeGreaterThan(0);
    expect(dl.names[0]).toMatch(/^Sara CRM - Tickets \(last 30 days\) - \d{4}-\d{2}-\d{2}\.xlsx$/);
    dl.restore();
  });

  it('always enriches with order data — it is no longer opt-in', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    api.useTicketOrders.mockReturnValue({
      data: new Map([
        ['c1', { orderId: 'o-9', restaurant: 'La Casa — Riyadh', status: 'delivered' }],
      ]),
      isFetching: false,
    });
    renderPage('tickets');

    // The "Include order data" checkbox is gone: this report exists to show
    // tickets ALONGSIDE the customer's order, so hiding that behind a toggle
    // made the report's whole purpose opt-in.
    expect(screen.queryByRole('checkbox', { name: /Include order data/ })).not.toBeInTheDocument();
    expect(api.useTicketOrders).toHaveBeenLastCalledWith(['c1', 'c2'], true, 30);
    expect(await screen.findByText('Restaurant')).toBeInTheDocument();
    expect(screen.getByText('La Casa — Riyadh')).toBeInTheDocument();
  });

  it('paginates the ticket table beyond ten rows', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...tickets[0]!,
      id: `p${i}`,
      subject: `Paged ticket ${String(i).padStart(2, '0')}`,
    }));
    api.useAgentReportData.mockReturnValue({ ...ok, data: { ...data, tickets: many } });
    renderPage('tickets');

    expect(screen.getByText('Paged ticket 00')).toBeInTheDocument();
    expect(screen.queryByText('Paged ticket 11')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '2' }));
    expect(screen.getByText('Paged ticket 11')).toBeInTheDocument();
    expect(screen.queryByText('Paged ticket 00')).not.toBeInTheDocument();
  });
});

describe('AgentReportsPage — agent KPI report', () => {
  it('renders one row per agent with formatted KPI values', () => {
    api.useAgentReportData.mockReturnValue(ok);
    const { container } = renderPage('agents');

    const body = within(container.querySelector('tbody') as HTMLElement);
    expect(body.getByText('Ann Lee')).toBeInTheDocument();
    expect(body.getByText('85%')).toBeInTheDocument(); // in-time 85.4 %
    expect(body.getByText('2m 5s')).toBeInTheDocument(); // first response 125s
    expect(body.getByText('2h 1m')).toBeInTheDocument(); // time to solve 7300s
    expect(body.getByText('4.26')).toBeInTheDocument(); // CSAT to 2 dp
    // The Unassigned bucket has nothing measured -> em dashes in the in-time,
    // first-response, time-to-solve and CSAT cells.
    expect(body.getAllByText('—').length).toBe(4);
  });

  it('sorts the agent table and exports the KPI workbook', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const dl = captureDownloads();
    const { container } = renderPage('agents');
    const firstAgent = () => container.querySelector('tbody tr td')?.textContent?.trim() ?? '';

    expect(firstAgent()).toBe('Ann Lee');
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(firstAgent()).toBe('Ann Lee'); // 'ann lee' < 'unassigned'
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(firstAgent()).toBe('Unassigned');

    await userEvent.click(screen.getByText('Export to Excel'));
    expect(dl.names[0]).toMatch(
      /^Sara CRM - Agent performance \(last 30 days\) - \d{4}-\d{2}-\d{2}\.xlsx$/,
    );
    dl.restore();
  });
});

describe('AgentReportsPage — conversation status report', () => {
  it('renders the status/priority breakdowns and the last 14 days', () => {
    api.useAgentReportData.mockReturnValue(ok);
    const { container } = renderPage('conversations');

    expect(screen.getByText('By status')).toBeInTheDocument();
    expect(screen.getByText('By priority')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument(); // open conversations
    expect(screen.getByText('13')).toBeInTheDocument(); // low priority

    // Two tables now: the conversations themselves, then the day matrix. The
    // matrix answers "how many"; the list answers "which", which is what
    // somebody reading a status report is about to act on.
    const tables = container.querySelectorAll('table');
    expect(tables).toHaveLength(2);
    const headersOf = (tbl: Element) =>
      Array.from(tbl.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
    expect(headersOf(tables[0]!)).toEqual([
      'Customer',
      'Phone',
      'Status',
      'Priority',
      'Agent',
      'Order',
      'Last message',
    ]);
    // One column per status, plus Date + Total.
    expect(headersOf(tables[1]!)).toEqual(['Date', 'Total', 'closed', 'open']);
    // 16 days of data, only the last 14 previewed.
    expect(tables[1]!.querySelectorAll('tbody tr')).toHaveLength(14);
    expect(
      screen.getByText('Showing the last 14 of 16 days — the export covers all.'),
    ).toBeInTheDocument();
  });

  it('opens the customers behind a status count', async () => {
    // "20 open" is a number; twenty phone numbers is a morning's work, and the
    // reason somebody clicks the box at all.
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    renderPage('conversations');

    const openBox = screen.getAllByRole('button').find((b) => /open/i.test(b.textContent ?? ''))!;
    await user.click(openBox);
    expect(openBox).toHaveAttribute('aria-expanded', 'true');
  });

  it('exports the three-sheet conversation workbook', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const dl = captureDownloads();
    renderPage('conversations');

    await userEvent.click(screen.getByText('Export to Excel'));
    expect(dl.blobs).toHaveLength(1);
    expect(dl.names[0]).toMatch(
      /^Sara CRM - Conversations \(last 30 days\) - \d{4}-\d{2}-\d{2}\.xlsx$/,
    );
    dl.restore();
  });

  it('hides the preview note when every day fits on screen', () => {
    api.useAgentReportData.mockReturnValue({
      ...ok,
      data: { ...data, conversations: { ...conversations, byDay: byDay.slice(0, 3) } },
    });
    renderPage('conversations');
    expect(screen.queryByText(/Showing the last/)).not.toBeInTheDocument();
  });
});

describe('AgentReportsPage — complaints report', () => {
  it("renders the operations manager's report under the Tickets heading", () => {
    // One report, named Tickets: a complaint IS a ticket, and two pages over
    // the same records only raised the question of which was authoritative.
    api.useAgentReportData.mockReturnValue(ok);
    renderPage('complaints');
    expect(screen.getAllByText('Tickets').length).toBeGreaterThan(0);
    expect(screen.getByText('2026-03-14')).toBeInTheDocument();
    expect(screen.getByText('19:11')).toBeInTheDocument();
  });

  it('resolves a branch whose name drifted, via its store code', () => {
    // The snapshot says "LCP-006 Panorama Mall"; the master says
    // "LCP-006 Panorama Mall RYD". Both name tiers miss, the code tier does
    // not — and the row must show the master's city, not "Not mapped".
    api.useAgentReportData.mockReturnValue(ok);
    const { container } = renderPage('complaints');
    const firstRow = container.querySelectorAll('tbody tr')[0]!;
    expect(within(firstRow as HTMLElement).getByText('LCP-006 Panorama Mall RYD')).toBeTruthy();
    expect(within(firstRow as HTMLElement).getByText('Riyadh')).toBeTruthy();
  });

  it('shows a store that is genuinely missing as "Not mapped", never blank', () => {
    api.useAgentReportData.mockReturnValue(ok);
    const { container } = renderPage('complaints');
    const secondRow = container.querySelectorAll('tbody tr')[1]! as HTMLElement;
    // The branch name survives — it is what someone needs in order to add it.
    expect(within(secondRow).getByText('CND-009 Nakhil Mall')).toBeTruthy();
    // Every store-derived column says so now that the table shows them all —
    // chain, area, brand and city — rather than a single representative cell.
    expect(within(secondRow).getAllByText('Not mapped').length).toBe(4);
  });

  it('counts the unmapped rows so the gap is visible without reading the table', () => {
    api.useAgentReportData.mockReturnValue(ok);
    renderPage('complaints');
    expect(screen.getByText('1 rows with an unmapped store')).toBeInTheDocument();
  });

  it('reports the branch as it was when the ticket was raised, not as it is now', async () => {
    // The store master now says Riyadh / Mo'men Elsharkasy (see PANORAMA), but
    // this ticket was raised when the branch sat in another city under another
    // manager. The report must show what was true then — re-resolving it live
    // would quietly reassign a months-old complaint to someone who never
    // handled it.
    api.useAgentReportData.mockReturnValue({
      ...ok,
      data: {
        ...data,
        complaints: [
          {
            ...complaints[0],
            storeSnapshot: {
              storeId: 's1',
              code: 'LCP-006',
              restaurantName: 'LCP-006 Panorama Mall RYD',
              brandName: 'Casa Pasta',
              city: 'Dammam',
              areaManager: 'Ahmed Samir',
              chainManager: 'Medhat Sayed',
              via: 'store_code',
              capturedAt: '2026-03-14T19:11:00.000Z',
            },
          },
        ],
      },
    });
    const { container } = renderPage('complaints');
    const row = container.querySelectorAll('tbody tr')[0]! as HTMLElement;
    expect(within(row).getByText('Dammam')).toBeTruthy();
    expect(within(row).queryByText('Riyadh')).toBeNull();
  });

  it('exports a complaints workbook', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const dl = captureDownloads();
    renderPage('complaints');

    // The button carries the COUNT now, so the promise it makes is visible
    // before it is clicked rather than checked by hand afterwards.
    await userEvent.click(screen.getByText('Export 2 rows'));
    expect(dl.blobs).toHaveLength(1);
    expect(dl.names[0]).toMatch(/^Sara CRM - Tickets \(last 30 days\) - \d{4}-\d{2}-\d{2}\.xlsx$/);
    dl.restore();
  });

  it('offers all 29 of her columns in the picker', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    renderPage('complaints');
    expect(screen.getByText('29/29')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Columns'));
    expect(screen.getByLabelText('Customer mobile')).toBeInTheDocument();
    expect(screen.getByLabelText('Restaurant manager')).toBeInTheDocument();
    // The date hierarchy her sheet pivots on.
    for (const c of ['Year', 'Month', 'Week', 'Day']) {
      expect(screen.getByLabelText(c)).toBeInTheDocument();
    }
    // Never had a value in her sheet, and her required format omits it.
    expect(screen.queryByLabelText('Customer name')).toBeNull();
  });

  it('finds a row by restaurant name, and says how many matched', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    const { container } = renderPage('complaints');

    await user.type(screen.getByLabelText(/Search by phone/), 'Panorama');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('finds a row by customer phone however it was typed', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    const { container } = renderPage('complaints');

    // Stored as 0511111111; searched with spacing and punctuation.
    await user.type(screen.getByLabelText(/Search by phone/), '051-111 1111');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('shows an honest empty result rather than the unfiltered table', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    const { container } = renderPage('complaints');

    await user.type(screen.getByLabelText(/Search by phone/), 'zzzznothing');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(screen.getByText('0 of 2')).toBeInTheDocument();
  });

  it('exports only what the search left on screen', async () => {
    // The filter is part of the question being asked; exporting everything
    // would quietly answer a different one.
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    const dl = captureDownloads();
    renderPage('complaints');

    await user.type(screen.getByLabelText(/Search by phone/), 'Panorama');
    // One row left after the filter, and the button says so — which is how a
    // reader knows it will not quietly export all 2.
    await user.click(screen.getByText('Export 1 rows'));
    expect(dl.blobs).toHaveLength(1);
    dl.restore();
  });

  it('moves a column later — the "put Date last" case', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    renderPage('complaints');

    await user.click(screen.getByText('Columns'));
    // Date starts first; move it one place later and the list reflects it.
    await user.click(screen.getByLabelText('Move Date later'));
    const labels = within(screen.getByRole('dialog'))
      .getAllByRole('checkbox')
      .map((c) => c.closest('label')?.textContent?.trim());
    expect(labels[0]).toBe('Year');
    expect(labels[1]).toBe('Date');
  });

  it('cannot move the first column earlier or the last one later', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    renderPage('complaints');

    await user.click(screen.getByText('Columns'));
    expect(screen.getByLabelText('Move Date earlier')).toBeDisabled();
    // The last column is now the audit stamp, not Compensation.
    expect(screen.getByLabelText('Move Last modified at later')).toBeDisabled();
  });

  it('offers page sizes worth having, and starts at 25 rather than 10', async () => {
    // The right size differs by task — 25 to read, 1000 to scan for a pattern
    // before exporting. Ten served neither.
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    renderPage('complaints');

    const combo = screen.getByRole('combobox', { name: 'Rows per page' });
    expect(combo).toHaveTextContent('25');
    await user.click(combo);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '25',
      '50',
      '100',
      '200',
      '1000',
    ]);
  });

  it('says which rows are on screen out of how many', () => {
    api.useAgentReportData.mockReturnValue(ok);
    renderPage('complaints');
    expect(screen.getByText('Showing 1–2 of 2')).toBeInTheDocument();
  });

  it('filters by complaint type exactly, from the values actually present', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    const { container } = renderPage('complaints');

    await user.click(screen.getByRole('combobox', { name: 'Complaint type' }));
    // Built from the rows in range — a menu of every type the company has ever
    // used is a list to read past, and picking an absent one looks like a bug.
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options[0]).toBe('Any');
    expect(options.length).toBeGreaterThan(1);

    await user.click(screen.getByRole('option', { name: options[1]! }));
    const shown = container.querySelectorAll('tbody tr').length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(2);
  });

  it('clears every filter at once', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    const { container } = renderPage('complaints');

    await user.type(screen.getByLabelText(/Search by phone/), 'zzzznothing');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);

    await user.click(screen.getByText('Clear filters'));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('hides the clear button when nothing is filtered', () => {
    api.useAgentReportData.mockReturnValue(ok);
    renderPage('complaints');
    expect(screen.queryByText('Clear filters')).toBeNull();
  });

  it('can send a column to the front in one action', async () => {
    // Twenty-seven ↑ clicks to move Compensation to the front was the actual
    // complaint about this panel.
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    renderPage('complaints');

    await user.click(screen.getByText('Columns'));
    await user.click(screen.getByLabelText('Move Compensation to the front'));
    const first = within(screen.getByRole('dialog')).getAllByRole('checkbox')[0]!.closest('label')!;
    expect(first).toHaveTextContent('Compensation');
  });

  it('finds a column by name instead of scrolling a list of 27', async () => {
    api.useAgentReportData.mockReturnValue(ok);
    const user = userEvent.setup({ delay: null });
    renderPage('complaints');

    await user.click(screen.getByText('Columns'));
    await user.type(screen.getByPlaceholderText('Find a column…'), 'coupon');
    // Row-select checkboxes live in table cells, not labels — only the
    // column-picker entries wrap theirs in a label.
    const labels = screen
      .getAllByRole('checkbox')
      .map((c) => c.closest('label')?.textContent)
      .filter((l): l is string => l != null);
    expect(labels.every((l) => /coupon/i.test(l))).toBe(true);
    expect(labels.length).toBe(3); // code, value, %
  });

  it('says the schema is missing rather than rendering 24 blank columns', () => {
    api.useAgentReportData.mockReturnValue({
      ...ok,
      data: { ...data, complaintFieldsAvailable: false },
    });
    renderPage('complaints');
    expect(screen.getByText('Complaint fields are not available here')).toBeInTheDocument();
    expect(screen.queryByText(/^Export \d+ rows$/)).not.toBeInTheDocument();
  });
});
