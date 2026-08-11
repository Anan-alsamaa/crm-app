import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  AgentKpiRow,
  ConversationStatusReport,
  TicketReportRow,
} from '../src/features/report-exports/api.js';
import {
  buildAgentKpiSheets,
  buildConversationSheets,
  buildTicketsSheets,
  fmtDateTime,
  reportFilename,
  TICKET_COLUMN_KEYS,
  TICKET_COLUMN_LABELS,
  type TicketColumnKey,
} from '../src/features/report-exports/export.js';

/**
 * Only `status.*` / `priority.*` are looked up in the shared `common`
 * namespace; everything else falls back to its `defaultValue`. Translating ONLY
 * for ns:'common' proves the builders route those two fields through it.
 */
const COMMON: Record<string, string> = {
  'status.open': 'Open',
  'status.closed': 'Closed',
  'priority.urgent': 'Urgent',
  'priority.low': 'Low',
};

function makeT() {
  return vi.fn((key: string, opts?: { defaultValue?: string; ns?: string }) =>
    opts?.ns === 'common' ? (COMMON[key] ?? opts.defaultValue ?? key) : (opts?.defaultValue ?? key),
  );
}

/** Local wall-clock ISO so the expected `YYYY-MM-DD HH:mm` is timezone-safe. */
const localIso = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min).toISOString();

function ticket(over: Partial<TicketReportRow> = {}): TicketReportRow {
  return {
    id: 't1',
    subject: 'Late order',
    status: 'open',
    priority: 'urgent',
    contactId: 'c1',
    contactName: 'Dana Ali',
    contactEmail: 'dana@example.com',
    contactPhone: '+971500000000',
    agentName: 'Ann Lee',
    createdAt: localIso(2026, 7, 22, 9, 5),
    firstResponseMinutes: 12.6,
    firstResponseState: 'met',
    resolutionMinutes: null,
    resolutionState: 'na',
    ...over,
  };
}

const headers = (cols: { header: string }[]) => cols.map((c) => c.header);
const allHeaders = TICKET_COLUMN_KEYS.map((k) => TICKET_COLUMN_LABELS[k].def);

afterEach(() => {
  vi.useRealTimers();
});

describe('buildTicketsSheets', () => {
  it('emits every column, in TICKET_COLUMN_KEYS order, when no selection is given', () => {
    const t = makeT();
    const sheets = buildTicketsSheets([ticket()], t);

    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe('Tickets');
    expect(headers(sheets[0]!.columns)).toEqual(allHeaders);
    expect(sheets[0]!.rows[0]).toHaveLength(TICKET_COLUMN_KEYS.length);
    // Every column carries an explicit width so Excel doesn't clip the export.
    expect(sheets[0]!.columns.every((c) => typeof c.width === 'number')).toBe(true);
  });

  it('emits only the selected columns, in the order the caller passes them', () => {
    // NOTE: the builder documents "order preserved" — it filters the caller's
    // array against the known keys but never re-sorts it. Canonical ordering is
    // the CALLER's job (see the next test); this asserts the documented contract.
    const t = makeT();
    const [sheet] = buildTicketsSheets([ticket()], t, ['status', 'id', 'subject']);

    expect(headers(sheet!.columns)).toEqual(['Status', 'Ticket ID', 'Subject']);
    expect(sheet!.rows).toEqual([['Open', 't1', 'Late order']]);
  });

  it('produces canonical order when the caller filters TICKET_COLUMN_KEYS (the page path)', () => {
    // AgentReportsPage keeps the selection in a Set and exports
    // `TICKET_COLUMN_KEYS.filter(k => cols.has(k))`, so a scrambled selection
    // still lands in canonical order in the sheet.
    const t = makeT();
    const picked = new Set<TicketColumnKey>(['orderTotal', 'status', 'id', 'subject']);
    const chosen = TICKET_COLUMN_KEYS.filter((k) => picked.has(k));
    const [sheet] = buildTicketsSheets([ticket()], t, chosen);

    expect(headers(sheet!.columns)).toEqual(['Ticket ID', 'Subject', 'Status', 'Order total']);
  });

  it('falls back to all columns for an empty or undefined selection', () => {
    const t = makeT();
    expect(headers(buildTicketsSheets([], t, [])[0]!.columns)).toEqual(allHeaders);
    expect(headers(buildTicketsSheets([], t, undefined)[0]!.columns)).toEqual(allHeaders);
  });

  it('drops unknown column keys instead of emitting a broken sheet', () => {
    const t = makeT();
    const enabled = ['id', 'not-a-column', 'subject'] as unknown as TicketColumnKey[];
    const [sheet] = buildTicketsSheets([ticket()], t, enabled);

    expect(headers(sheet!.columns)).toEqual(['Ticket ID', 'Subject']);
    expect(sheet!.rows).toEqual([['t1', 'Late order']]);
  });

  it('maps row values: common-namespace labels, rounded minutes, blank nulls', () => {
    const t = makeT();
    const [sheet] = buildTicketsSheets(
      [
        ticket({
          firstResponseMinutes: 12.6,
          resolutionMinutes: 90.4,
          resolutionState: 'breached',
        }),
      ],
      t,
    );
    const row = sheet!.rows[0]!;
    const at = (k: TicketColumnKey) => row[TICKET_COLUMN_KEYS.indexOf(k)];

    expect(at('id')).toBe('t1');
    expect(at('status')).toBe('Open'); // via ns: 'common'
    expect(at('priority')).toBe('Urgent'); // via ns: 'common'
    expect(at('contact')).toBe('Dana Ali');
    expect(at('email')).toBe('dana@example.com');
    expect(at('phone')).toBe('+971500000000');
    expect(at('agent')).toBe('Ann Lee');
    expect(at('created')).toBe('2026-07-22 09:05');
    expect(at('firstResponseMin')).toBe(13); // 12.6 rounded
    expect(at('resolutionMin')).toBe(90); // 90.4 rounded
    expect(at('firstResponseSla')).toBe('met');
    expect(at('resolutionSla')).toBe('breached');

    // status/priority really go through the shared namespace.
    expect(t).toHaveBeenCalledWith('status.open', { ns: 'common', defaultValue: 'open' });
    expect(t).toHaveBeenCalledWith('priority.urgent', { ns: 'common', defaultValue: 'urgent' });
  });

  it('blanks null minutes and renders the "na" SLA state as an em dash', () => {
    const t = makeT();
    const [sheet] = buildTicketsSheets(
      [ticket({ firstResponseMinutes: null, firstResponseState: 'na', resolutionMinutes: null })],
      t,
    );
    const row = sheet!.rows[0]!;
    expect(row[TICKET_COLUMN_KEYS.indexOf('firstResponseMin')]).toBe('');
    expect(row[TICKET_COLUMN_KEYS.indexOf('resolutionMin')]).toBe('');
    expect(row[TICKET_COLUMN_KEYS.indexOf('firstResponseSla')]).toBe('—');
  });

  it('blanks every order column when the row has no linked order', () => {
    const t = makeT();
    const orderCols: TicketColumnKey[] = [
      'orderId',
      'restaurant',
      'orderStatus',
      'delivery',
      'items',
      'orderTotal',
    ];
    const [sheet] = buildTicketsSheets([ticket({ order: null })], t, orderCols);
    expect(sheet!.rows).toEqual([['', '', '', '', '', '']]);

    // …and undefined (never enriched) behaves the same as an explicit null.
    const [plain] = buildTicketsSheets([ticket()], t, orderCols);
    expect(plain!.rows).toEqual([['', '', '', '', '', '']]);
  });

  it('emits the linked order fields when enrichment resolved', () => {
    const t = makeT();
    const orderCols: TicketColumnKey[] = ['orderId', 'restaurant', 'orderStatus', 'orderTotal'];
    const [sheet] = buildTicketsSheets(
      [
        ticket({
          order: {
            orderId: 'o-9',
            restaurant: 'La Casa — Riyadh',
            status: 'delivered',
            delivery: 'In Delivery',
            items: '2× Pasta',
            total: 145.5,
            currency: 'SAR',
          },
        }),
      ],
      t,
      orderCols,
    );
    expect(sheet!.rows).toEqual([['o-9', 'La Casa — Riyadh', 'delivered', 145.5]]);
  });
});

describe('buildAgentKpiSheets', () => {
  const agents: AgentKpiRow[] = [
    {
      agentId: 'u1',
      agentName: 'Ann Lee',
      tickets: 5,
      responded: 4,
      avgFirstResponseMin: 12.4,
      firstResponsePct: 66.6,
      csatCount: 3,
      csatAvg: 4.26,
      missed: 1,
      offered: 6,
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
    },
  ];

  it('builds one sheet with the seven KPI columns', () => {
    const [sheet] = buildAgentKpiSheets(agents, makeT());
    expect(sheet!.name).toBe('Agent KPI');
    expect(headers(sheet!.columns)).toEqual([
      'Agent',
      'Tickets',
      'Responded',
      'Avg first response (min)',
      'First response SLA %',
      'CSAT responses',
      'CSAT avg (1–5)',
    ]);
  });

  it('rounds minutes/percent to whole numbers and CSAT to one decimal', () => {
    const [sheet] = buildAgentKpiSheets(agents, makeT());
    expect(sheet!.rows[0]).toEqual(['Ann Lee', 5, 4, 12, 67, 3, 4.3]);
  });

  it('blanks the derived cells for an agent with nothing measured', () => {
    const [sheet] = buildAgentKpiSheets(agents, makeT());
    expect(sheet!.rows[1]).toEqual(['Unassigned', 1, 0, '', '', 0, '']);
  });
});

describe('buildConversationSheets', () => {
  const report: ConversationStatusReport = {
    rows: [
      {
        id: 'c1',
        status: 'open',
        priority: 'urgent',
        agentName: 'Ann Lee',
        createdAt: localIso(2026, 7, 22, 9, 5),
        lastMessageAt: null,
      },
      {
        id: 'c2',
        status: 'closed',
        priority: 'low',
        agentName: 'Unassigned',
        createdAt: null,
        lastMessageAt: localIso(2026, 7, 22, 14, 30),
      },
    ],
    byStatus: [
      { key: 'open', count: 2 },
      { key: 'closed', count: 1 },
    ],
    byPriority: [
      { key: 'urgent', count: 2 },
      { key: 'low', count: 1 },
    ],
    byDay: [
      { day: '2026-07-21', total: 1, byStatus: { open: 1 } },
      { day: '2026-07-22', total: 2, byStatus: { open: 1, closed: 1 } },
    ],
    statuses: ['closed', 'open'],
    total: 3,
  };

  it('returns the summary / by-day / detail sheets in that order', () => {
    const sheets = buildConversationSheets(report, makeT());
    expect(sheets.map((s) => s.name)).toEqual(['Summary', 'By day', 'Conversations']);
  });

  it('lays the summary out as status block, priority block, then the total', () => {
    const [summary] = buildConversationSheets(report, makeT());
    expect(headers(summary!.columns)).toEqual(['Metric', 'Count']);
    expect(summary!.rows).toEqual([
      ['By status', ''],
      ['Open', 2],
      ['Closed', 1],
      ['', ''],
      ['By priority', ''],
      ['Urgent', 2],
      ['Low', 1],
      ['', ''],
      ['Total', 3],
    ]);
  });

  it('adds one by-day column per status and back-fills missing days with 0', () => {
    const day = buildConversationSheets(report, makeT())[1]!;
    expect(headers(day.columns)).toEqual(['Date', 'Total', 'Closed', 'Open']);
    expect(day.rows).toEqual([
      ['2026-07-21', 1, 0, 1], // no `closed` that day -> 0, not blank
      ['2026-07-22', 2, 1, 1],
    ]);
  });

  it('renders one detail row per conversation with formatted timestamps', () => {
    const detail = buildConversationSheets(report, makeT())[2]!;
    expect(headers(detail.columns)).toEqual([
      'Conversation ID',
      'Status',
      'Priority',
      'Agent',
      'Created',
      'Last message',
    ]);
    expect(detail.rows).toEqual([
      ['c1', 'Open', 'Urgent', 'Ann Lee', '2026-07-22 09:05', ''],
      ['c2', 'Closed', 'Low', 'Unassigned', '', '2026-07-22 14:30'],
    ]);
  });

  it('still emits three sheets for an empty report', () => {
    const empty: ConversationStatusReport = {
      rows: [],
      byStatus: [],
      byPriority: [],
      byDay: [],
      statuses: [],
      total: 0,
    };
    const sheets = buildConversationSheets(empty, makeT());
    expect(sheets).toHaveLength(3);
    expect(sheets[0]!.rows).toEqual([
      ['By status', ''],
      ['', ''],
      ['By priority', ''],
      ['', ''],
      ['Total', 0],
    ]);
    expect(sheets[1]!.rows).toEqual([]);
    expect(sheets[2]!.rows).toEqual([]);
  });
});

describe('fmtDateTime', () => {
  it('formats an ISO timestamp as local YYYY-MM-DD HH:mm with zero padding', () => {
    expect(fmtDateTime(localIso(2026, 7, 22, 9, 5))).toBe('2026-07-22 09:05');
    expect(fmtDateTime(localIso(2026, 1, 3, 23, 59))).toBe('2026-01-03 23:59');
  });

  it('returns a blank cell for null, undefined and empty input', () => {
    expect(fmtDateTime(null)).toBe('');
    expect(fmtDateTime(undefined)).toBe('');
    expect(fmtDateTime('')).toBe('');
  });

  it('returns a blank cell for an unparseable string rather than "Invalid Date"', () => {
    expect(fmtDateTime('not-a-timestamp')).toBe('');
  });
});

describe('reportFilename', () => {
  it('stamps the base name with the window length and today (UTC) date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T10:30:00.000Z'));
    expect(reportFilename('reports-tickets', 30)).toBe('reports-tickets-30d-2026-07-22.xlsx');
    expect(reportFilename('reports-agent-kpi', 7)).toBe('reports-agent-kpi-7d-2026-07-22.xlsx');
  });
});
