import { describe, it, expect } from 'vitest';
import {
  distinctValues,
  filterTickets,
  isEmptyFilter,
  matchesTicketFilter,
  type FilterableTicketRow,
} from '../src/ticket-filter.js';

const row = (over: Partial<FilterableTicketRow> = {}): FilterableTicketRow => ({
  date: '2026-08-13',
  complaintType: 'Missing item',
  customerMobile: '+966 55 512 3456',
  orderNumber: '946641',
  restaurantName: 'Masief Plaza',
  complaintDescription: 'Two burgers missing.',
  responseDesc: 'Refunded.',
  complaintStatus: 'open',
  agent: 'Sara',
  brand: 'LCP',
  city: 'Riyadh',
  serviceType: 'Delivery',
  complaintSource: 'Comp. WhatsApp',
  compensation: 'Compensated',
  storeCode: 'LCP-032',
  yijiRestaurantId: '39',
  ...over,
});

describe('free-text search', () => {
  it('finds a ticket by its order number', () => {
    expect(matchesTicketFilter(row(), { query: '946641' })).toBe(true);
    expect(matchesTicketFilter(row(), { query: '999999' })).toBe(false);
  });

  it('finds one by phone however the number was typed', () => {
    // Stored with spaces and a country code; searched as a bare fragment.
    expect(matchesTicketFilter(row(), { query: '5123456' })).toBe(true);
    expect(matchesTicketFilter(row(), { query: '55 512' })).toBe(true);
  });

  it('will not match a phone on one or two digits', () => {
    // A two-digit search matches almost every number on file, which is the same
    // as no search at all.
    expect(matchesTicketFilter(row(), { query: '55' })).toBe(false);
  });

  it('finds one by branch, store code or Yiji id', () => {
    expect(matchesTicketFilter(row(), { query: 'masief' })).toBe(true);
    expect(matchesTicketFilter(row(), { query: 'lcp-032' })).toBe(true);
    expect(matchesTicketFilter(row(), { query: '39' })).toBe(true);
  });

  it('searches what was written about it, not only its keys', () => {
    expect(matchesTicketFilter(row(), { query: 'burgers' })).toBe(true);
    expect(matchesTicketFilter(row(), { query: 'refunded' })).toBe(true);
  });

  it('works on a row with no store join', () => {
    const bare = { ...row() };
    delete bare.storeCode;
    delete bare.yijiRestaurantId;
    expect(matchesTicketFilter(bare, { query: '946641' })).toBe(true);
  });
});

describe('exact filters', () => {
  it('matches a complaint type exactly, not as a substring', () => {
    // "Late order" must not pull in "Order Late in store".
    expect(
      matchesTicketFilter(row({ complaintType: 'Late order' }), { complaintType: 'Late order' }),
    ).toBe(true);
    expect(
      matchesTicketFilter(row({ complaintType: 'Order Late in store' }), {
        complaintType: 'Late order',
      }),
    ).toBe(false);
  });

  it('ignores case and stray spaces in the chosen value', () => {
    expect(matchesTicketFilter(row(), { complaintType: '  missing ITEM ' })).toBe(true);
  });

  it('ANDs the criteria together', () => {
    const r = row();
    expect(matchesTicketFilter(r, { complaintType: 'Missing item', city: 'Riyadh' })).toBe(true);
    expect(matchesTicketFilter(r, { complaintType: 'Missing item', city: 'Jeddah' })).toBe(false);
  });
});

describe('date range', () => {
  it('includes both ends of the range', () => {
    expect(matchesTicketFilter(row(), { from: '2026-08-13', to: '2026-08-13' })).toBe(true);
  });

  it('excludes rows outside it', () => {
    expect(matchesTicketFilter(row(), { from: '2026-08-14' })).toBe(false);
    expect(matchesTicketFilter(row(), { to: '2026-08-12' })).toBe(false);
  });

  it('drops a row with no date rather than letting it through a range', () => {
    // A dateless row in a "this week" report is a row claiming to be in a week
    // nobody can check.
    expect(matchesTicketFilter(row({ date: '' }), { from: '2026-08-01' })).toBe(false);
    // ...but it survives when no range was asked for.
    expect(matchesTicketFilter(row({ date: '' }), {})).toBe(true);
  });
});

describe('filterTickets', () => {
  it('returns everything for empty criteria', () => {
    const rows = [row(), row({ orderNumber: '2' })];
    expect(filterTickets(rows, {})).toHaveLength(2);
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ query: '   ' })).toBe(true);
    expect(isEmptyFilter({ query: '946' })).toBe(false);
  });

  it('does not mutate the input', () => {
    const rows = [row(), row({ orderNumber: '2' })];
    filterTickets(rows, { query: '946641' });
    expect(rows).toHaveLength(2);
  });
});

describe('distinctValues', () => {
  it('lists what is actually in the data, sorted, without blanks', () => {
    // Built from the rows, not the enum: a menu of thirty types when the range
    // holds three is a list to read past, and picking an absent one returns an
    // empty table that looks like a bug.
    const rows = [
      row({ complaintType: 'Missing item' }),
      row({ complaintType: 'Late order' }),
      row({ complaintType: 'Missing item' }),
      row({ complaintType: '' }),
    ];
    expect(distinctValues(rows, 'complaintType')).toEqual(['Late order', 'Missing item']);
  });
});
