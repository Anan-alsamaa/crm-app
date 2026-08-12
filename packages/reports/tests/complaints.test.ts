import { describe, it, expect } from 'vitest';
import { buildStoreIndex, toStoreSnapshot, matchStore } from '@yiji/shared-types';
import {
  buildComplaintsSheets,
  COMPLAINT_COLUMN_KEYS,
  countUnmappedComplaints,
  joinComplaintStores,
  reportFilename,
  splitLocalDateTime,
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
  it('is the ops sheet, in their order — 24 columns', () => {
    // Pinned deliberately: this format is reconciled against a spreadsheet
    // someone keeps by hand, so a column silently appearing or moving is a
    // defect, not a detail.
    expect(COMPLAINT_COLUMN_KEYS).toHaveLength(24);
    expect(COMPLAINT_COLUMN_KEYS[0]).toBe('date');
    expect(COMPLAINT_COLUMN_KEYS[1]).toBe('time');
    expect(COMPLAINT_COLUMN_KEYS.at(-1)).toBe('compensation');
  });

  it('emits every column by default, and only the chosen ones otherwise', () => {
    const all = buildComplaintsSheets([row()], t)[0]!;
    expect(all.columns).toHaveLength(24);

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
    expect(splitLocalDateTime(null)).toEqual({ date: '', time: '' });
    expect(splitLocalDateTime('nonsense')).toEqual({ date: '', time: '' });
  });

  it('names the workbook with its range', () => {
    expect(reportFilename('my-complaints', 30)).toMatch(
      /^my-complaints-30d-\d{4}-\d{2}-\d{2}\.xlsx$/,
    );
  });
});
