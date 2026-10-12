import { describe, it, expect } from 'vitest';
import {
  couponStage,
  defaultPerformanceRange,
  matchesSearch,
  mean,
  median,
  phoneQueryDigits,
} from '../src/performance-search.js';

/**
 * The agent-performance search, shared by both portals since the admin console
 * gained the same box (owner, 2026-10-12: "a search by order id, ticket id,
 * coupon code and stuff"). One matcher, so a query finds the same rows in
 * either portal.
 */
describe('matchesSearch', () => {
  const ticketRow = {
    phones: ['+966501234567', null],
    text: ['4417', 'ORD-998877', 'Late delivery', 'Cold food', 'COMP50', 'Sara Ali'],
  };

  it('matches everything on an empty query', () => {
    expect(matchesSearch('', ticketRow)).toBe(true);
    expect(matchesSearch('   ', ticketRow)).toBe(true);
  });

  it('finds a row by ticket id, order id, coupon code and title, ignoring case', () => {
    expect(matchesSearch('4417', ticketRow)).toBe(true);
    expect(matchesSearch('ord-998877', ticketRow)).toBe(true);
    expect(matchesSearch('comp50', ticketRow)).toBe(true);
    expect(matchesSearch('late deliv', ticketRow)).toBe(true);
    expect(matchesSearch('NOPE-1', ticketRow)).toBe(false);
  });

  it('finds a customer by number in any of the three spellings', () => {
    for (const q of ['0501234567', '+966501234567', '966501234567', '00966501234567', '1234567'])
      expect(matchesSearch(q, ticketRow)).toBe(true);
    expect(matchesSearch('0559999999', ticketRow)).toBe(false);
  });

  it('needs three digits before treating a query as a phone', () => {
    // "05" alone would match every Saudi mobile on the page.
    expect(matchesSearch('05', { phones: ['0501234567'], text: [] })).toBe(false);
    expect(matchesSearch('050', { phones: ['0501234567'], text: [] })).toBe(true);
  });

  it('brings the query digits to the stored 05 form', () => {
    expect(phoneQueryDigits('+966 50 123 4567')).toBe('0501234567');
    expect(phoneQueryDigits('00966501234567')).toBe('0501234567');
    expect(phoneQueryDigits('0501234567')).toBe('0501234567');
  });
});

describe('couponStage', () => {
  it('names each stage the way an agent repeats it to a customer', () => {
    expect(couponStage({ status: 'pending' })).toBe('waitingApproval');
    expect(couponStage({ status: 'rejected' })).toBe('rejected');
    expect(couponStage({ status: 'assigned' })).toBe('delivered');
    expect(couponStage({ status: 'approved', awaiting_signup_at: '2026-10-01T00:00:00Z' })).toBe(
      'waitingSignup',
    );
    expect(couponStage({ status: 'approved', delivery_excluded: true, yiji_coupon_id: 'y1' })).toBe(
      'createdNotAssigned',
    );
    expect(couponStage({ status: 'approved' })).toBe('approved');
  });
});

describe('mean / median', () => {
  it('returns null for nothing rather than a zero', () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
  });
  it('rounds to the second', () => {
    expect(mean([1, 2])).toBe(2);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3);
  });
});

describe('defaultPerformanceRange', () => {
  it('opens on yesterday through today (business days turn at 08:00 Riyadh)', () => {
    expect(defaultPerformanceRange(Date.parse('2026-10-11T11:00:00Z'))).toEqual({
      from: '2026-10-10',
      to: '2026-10-11',
    });
  });
});
