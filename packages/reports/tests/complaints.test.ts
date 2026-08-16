import { describe, it, expect } from 'vitest';
import { buildStoreIndex, toStoreSnapshot, matchStore } from '@yiji/shared-types';
import {
  buildComplaintsSheets,
  COMPLAINT_COLUMN_KEYS,
  countUnmappedComplaints,
  joinComplaintStores,
  reportFilename,
  splitLocalDateTime,
  isoWeek,
  filterComplaintRows,
  moveColumn,
  reconcileColumnOrder,
  COMPLAINT_COLUMN_LABELS,
  type ComplaintReportRow,
} from '../src/index.js';

/** Identity translator: returns the default, so assertions read as English. */
const t = (_k: string, o?: { defaultValue: string }) => o?.defaultValue ?? _k;

function row(over: Partial<ComplaintReportRow> = {}): ComplaintReportRow {
  return {
    id: 'tk-1',
    date: '2026-08-01',
    time: '10:30',
    chain: '',
    area: '',
    brand: '',
    city: '',
    restaurantName: '',
    storeMapped: false,
    serviceType: '',
    complaintType: '',
    customerName: '',
    customerMobile: '',
    complaintDescription: '',
    responseDesc: '',
    complaintSource: '',
    orderAmount: null,
    orderNumber: '',
    communicationMethod: '',
    couponCode: '',
    couponValue: null,
    couponPercent: null,
    complaintStatus: 'open',
    agent: 'Sara',
    compensation: '',
    storeSnapshot: null,
    ...over,
  };
}

const stores = buildStoreIndex([
  {
    id: 's1',
    code: 'LCP-041',
    name: 'Masief Plaza',
    city: 'Riyadh',
    areaManager: 'Area Ali',
    chainManager: 'Chain Noura',
    brandCode: 'LCP',
    brandName: 'La Casa Pasta',
    brandYijiName: 'La Casa Pasta',
    yijiRestaurantId: '312',
  },
]);

describe('the complaint column set', () => {
  it('is the ops sheet, in their order — 29 columns', () => {
    // Pinned deliberately: this format is reconciled against a spreadsheet
    // someone keeps by hand, so a column silently appearing or moving is a
    // defect, not a detail. 27 since the date hierarchy (year/month/week/day)
    // was added and the always-empty customer name dropped.
    // 29 = the ops sheet's 27 plus the audit pair added at the owner's
    // request: who last modified the complaint, and when.
    expect(COMPLAINT_COLUMN_KEYS).toHaveLength(29);
    expect(COMPLAINT_COLUMN_KEYS).toContain('lastModifiedBy');
    expect(COMPLAINT_COLUMN_KEYS).toContain('lastModifiedAt');
    expect(COMPLAINT_COLUMN_KEYS[0]).toBe('date');
    expect(COMPLAINT_COLUMN_KEYS[1]).toBe('year');
    expect(COMPLAINT_COLUMN_KEYS.at(-1)).toBe('lastModifiedAt');
  });

  it('emits every column by default, and only the chosen ones otherwise', () => {
    const all = buildComplaintsSheets([row()], t)[0]!;
    expect(all.columns).toHaveLength(29);

    const picked = buildComplaintsSheets([row()], t, ['date', 'agent'])[0]!;
    expect(picked.columns.map((c) => c.header)).toEqual(['Date', 'Agent']);
    expect(picked.rows[0]).toEqual(['2026-08-01', 'Sara']);
  });

  it('writes the mobile as text so Excel keeps a leading + or zero', () => {
    const sheet = buildComplaintsSheets([row({ customerMobile: '+966501234567' })], t, [
      'customerMobile',
    ])[0]!;
    expect(sheet.rows[0]![0]).toBe('+966501234567');
  });
});

describe('joinComplaintStores', () => {
  it('resolves the branch and reports it as the store master names it', () => {
    const [joined] = joinComplaintStores(
      [row({ restaurantName: 'Riyadh - Masief Plaza', brand: 'La Casa Pasta' })],
      stores,
    );
    expect(joined!.storeMapped).toBe(true);
    expect(joined!.city).toBe('Riyadh');
    expect(joined!.area).toBe('Area Ali');
    expect(joined!.chain).toBe('Chain Noura');
  });

  it('marks an unresolved branch rather than blanking it', () => {
    const [joined] = joinComplaintStores([row({ restaurantName: 'Somewhere Else' })], stores);
    expect(joined!.storeMapped).toBe(false);
    // The branch NAME survives — it is what someone needs to fix the mapping.
    expect(joined!.restaurantName).toBe('Somewhere Else');
    expect(countUnmappedComplaints(joined ? [joined] : [])).toBe(1);
  });

  it('leaves a complaint with no branch alone, and out of the unmapped count', () => {
    const [joined] = joinComplaintStores([row()], stores);
    expect(joined!.storeMapped).toBe(false);
    expect(countUnmappedComplaints([joined!])).toBe(0);
  });

  it('prefers the frozen snapshot over a live re-match', () => {
    // The whole point of freezing: editing the store master today must not
    // rewrite who was responsible for a complaint raised months ago.
    const frozen = toStoreSnapshot(
      matchStore(stores, { restaurantName: 'Riyadh - Masief Plaza', brandName: 'La Casa Pasta' }),
      '2026-01-01T00:00:00.000Z',
    );
    const movedOn = buildStoreIndex([]); // store master no longer has it
    const [joined] = joinComplaintStores(
      [row({ restaurantName: 'Riyadh - Masief Plaza', storeSnapshot: frozen })],
      movedOn,
    );
    expect(joined!.city).toBe('Riyadh');
    expect(joined!.storeMapped).toBe(true);
  });

  it('renders an unmapped branch as "Not mapped" in every store column', () => {
    const joined = joinComplaintStores([row({ restaurantName: 'Somewhere Else' })], stores);
    const sheet = buildComplaintsSheets(joined, t, ['city', 'chain', 'area', 'restaurantName'])[0]!;
    expect(sheet.rows[0]).toEqual([
      'Not mapped',
      'Not mapped',
      'Not mapped',
      // …except the branch name, which is the thing you need to fix it.
      'Somewhere Else',
    ]);
  });
});

describe('helpers', () => {
  it('splits a timestamp into the sheet local date and time', () => {
    const { date, time } = splitLocalDateTime('2026-08-01T10:30:00');
    expect(date).toBe('2026-08-01');
    expect(time).toBe('10:30');
  });

  it('is blank rather than "Invalid Date" for a missing timestamp', () => {
    const blank = { date: '', time: '', year: null, month: null, week: null, day: null };
    expect(splitLocalDateTime(null)).toEqual(blank);
    expect(splitLocalDateTime('nonsense')).toEqual(blank);
  });

  it('names the workbook with its range', () => {
    expect(reportFilename('my-complaints', 30)).toMatch(
      /^Sara CRM - my-complaints \(last 30 days\) - \d{4}-\d{2}-\d{2}\.xlsx$/,
    );
  });
});

describe('date parts for pivoting', () => {
  it('derives year, month, week and day from the ticket date', () => {
    const p = splitLocalDateTime(new Date(2026, 2, 14, 19, 11).toISOString());
    expect(p).toMatchObject({ date: '2026-03-14', time: '19:11', year: 2026, month: 3, day: 14 });
  });

  it('emits numbers, so Excel sorts months chronologically not alphabetically', () => {
    const p = splitLocalDateTime(new Date(2026, 0, 5, 9, 0).toISOString());
    expect(typeof p.month).toBe('number');
    expect(p.month).toBe(1);
  });

  it('matches Excel ISOWEEKNUM on the awkward year boundaries', () => {
    // 2026-01-01 is a Thursday, so it belongs to week 1 of 2026.
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1);
    // 2027-01-01 is a Friday: ISO puts it in week 53 of 2026, not week 1.
    expect(isoWeek(new Date(2027, 0, 1))).toBe(53);
    expect(isoWeek(new Date(2026, 11, 31))).toBe(53);
  });

  it('is all-null for a missing or unparseable date rather than 1970', () => {
    for (const bad of [null, undefined, 'nonsense']) {
      expect(splitLocalDateTime(bad)).toEqual({
        date: '',
        time: '',
        year: null,
        month: null,
        week: null,
        day: null,
      });
    }
  });
});

describe('the required column set', () => {
  it('is the operations sheet order, starting with the date hierarchy', () => {
    expect(COMPLAINT_COLUMN_KEYS.slice(0, 5)).toEqual(['date', 'year', 'month', 'week', 'day']);
  });

  it('puts Time after Complaint Source, where their sheet has it', () => {
    const k = [...COMPLAINT_COLUMN_KEYS];
    expect(k.indexOf('time')).toBe(k.indexOf('complaintSource') + 1);
  });

  it('has no customer-name column', () => {
    expect(COMPLAINT_COLUMN_KEYS).not.toContain('customerName');
  });

  it('labels a every column', () => {
    for (const k of COMPLAINT_COLUMN_KEYS) expect(COMPLAINT_COLUMN_LABELS[k]?.def).toBeTruthy();
  });
});

describe('filterComplaintRows', () => {
  const row = (over: Partial<ComplaintReportRow>): ComplaintReportRow =>
    ({
      restaurantName: 'LCP-041 Masief Plaza',
      storeCode: 'LCP-041',
      yijiRestaurantId: '312',
      customerMobile: '0501234567',
      orderNumber: '946641',
      ...over,
    }) as ComplaintReportRow;

  const rows = [
    row({}),
    row({
      restaurantName: 'PSK-002 Nakhil Mall',
      storeCode: 'PSK-002',
      yijiRestaurantId: '947',
      customerMobile: '0559876543',
      orderNumber: '946642',
    }),
  ];

  it('finds a complaint by its order number', () => {
    expect(filterComplaintRows(rows, '946641')[0]!.storeCode).toBe('LCP-041');
  });

  it('finds a branch by name', () => {
    expect(filterComplaintRows(rows, 'nakhil')).toHaveLength(1);
  });

  it('finds a branch by its ops store code', () => {
    expect(filterComplaintRows(rows, 'LCP-041')[0]!.storeCode).toBe('LCP-041');
  });

  it('finds a branch by its Yiji restaurant id', () => {
    expect(filterComplaintRows(rows, '947')[0]!.storeCode).toBe('PSK-002');
  });

  it('finds a customer however the number was written', () => {
    // Same number, three spellings people actually type.
    for (const q of ['0501234567', '+966 50 123 4567'.replace('966', ''), '501234567']) {
      expect(filterComplaintRows(rows, q).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('ignores punctuation and spacing in a phone search', () => {
    expect(filterComplaintRows(rows, '055-987-6543')).toHaveLength(1);
  });

  it('will not phone-match on one or two digits', () => {
    // "5" appears in nearly every number; matching it would return everything
    // and make the box feel broken.
    expect(filterComplaintRows(rows, '5')).toHaveLength(0);
  });

  it('returns everything for an empty query, and a copy not the original', () => {
    const out = filterComplaintRows(rows, '   ');
    expect(out).toHaveLength(2);
    expect(out).not.toBe(rows);
  });
});

describe('moveColumn / reconcileColumnOrder', () => {
  const order = ['date', 'time', 'agent'] as const;

  it('moves a column to the end — the example of wanting Date last', () => {
    expect(moveColumn(order, 0, 2)).toEqual(['time', 'agent', 'date']);
  });

  it('moves a column to the front', () => {
    expect(moveColumn(order, 2, 0)).toEqual(['agent', 'date', 'time']);
  });

  it('clamps a drag that overshoots instead of throwing', () => {
    expect(moveColumn(order, 0, 99)).toEqual(['time', 'agent', 'date']);
    expect(moveColumn(order, 0, -5)).toEqual(['date', 'time', 'agent']);
  });

  it('leaves the order alone when the source index is nonsense', () => {
    expect(moveColumn(order, 9, 0)).toEqual(['date', 'time', 'agent']);
  });

  it('does not mutate the order it was given', () => {
    const src = [...order];
    moveColumn(src, 0, 2);
    expect(src).toEqual(['date', 'time', 'agent']);
  });

  it('keeps a saved order working after a column is added', () => {
    // The saved preference predates `week`; it must still apply, with the new
    // column appended rather than silently missing from the report.
    expect(reconcileColumnOrder(['agent', 'date'], ['date', 'agent', 'week'])).toEqual([
      'agent',
      'date',
      'week',
    ]);
  });

  it('drops a saved column that no longer exists', () => {
    expect(reconcileColumnOrder(['gone', 'date'], ['date', 'agent'])).toEqual(['date', 'agent']);
  });
});
