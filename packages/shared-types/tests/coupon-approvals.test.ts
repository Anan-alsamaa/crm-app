import { describe, it, expect } from 'vitest';
import {
  approvedCouponPatch,
  couponRequestProblem,
  isCouponRequested,
  splitCouponForApproval,
  type CouponInput,
} from '../src/coupon-approvals.js';

const input = (over: Partial<CouponInput> = {}): CouponInput => ({
  coupon_code: '',
  coupon_value: '',
  coupon_percent: '',
  compensation: '',
  ...over,
});

describe('isCouponRequested', () => {
  it('counts a code, an amount or a percentage as a coupon', () => {
    expect(isCouponRequested(input({ coupon_code: 'SORRY10' }))).toBe(true);
    expect(isCouponRequested(input({ coupon_value: '25' }))).toBe(true);
    expect(isCouponRequested(input({ coupon_percent: '10' }))).toBe(true);
  });

  it('does not count the compensation dropdown on its own', () => {
    // "Not Compensated" says nothing was given. Queueing that for approval
    // would bury the real requests under a queue of nothing.
    expect(isCouponRequested(input({ compensation: 'Not Compensated' }))).toBe(false);
    expect(isCouponRequested(input({ compensation: 'Compensated' }))).toBe(false);
  });

  it('ignores whitespace typed into a field', () => {
    expect(isCouponRequested(input({ coupon_code: '   ' }))).toBe(false);
  });

  it('counts a zero-value coupon — it is still a decision somebody made', () => {
    expect(isCouponRequested(input({ coupon_value: '0' }))).toBe(true);
  });
});

describe('splitCouponForApproval', () => {
  it('keeps the coupon OFF the ticket until it is approved', () => {
    const { ticket, request } = splitCouponForApproval(
      input({ coupon_code: 'SORRY10', coupon_value: '25', compensation: 'Compensated' }),
    );
    // The whole control: writing it first and asking after makes approval a
    // formality applied to money already promised.
    expect(ticket).toEqual({
      coupon_code: null,
      coupon_value: null,
      coupon_percent: null,
      compensation: null,
    });
    expect(request).toEqual({
      coupon_code: 'SORRY10',
      coupon_value: 25,
      coupon_percent: null,
      compensation: 'Compensated',
    });
  });

  it('withholds "Compensated" too, not just the coupon', () => {
    // A ticket saying Compensated with no coupon on it reads as a coupon that
    // was issued and then lost.
    const { ticket } = splitCouponForApproval(
      input({ coupon_code: 'X', compensation: 'Compensated' }),
    );
    expect(ticket.compensation).toBeNull();
  });

  it('lets a ticket record "Not Compensated" immediately — there is nothing to approve', () => {
    const { ticket, request } = splitCouponForApproval(input({ compensation: 'Not Compensated' }));
    expect(request).toBeNull();
    expect(ticket.compensation).toBe('Not Compensated');
  });

  it('turns the typed numbers into real numbers', () => {
    const { request } = splitCouponForApproval(
      input({ coupon_value: '25.5', coupon_percent: '10' }),
    );
    expect(request).toMatchObject({ coupon_value: 25.5, coupon_percent: 10 });
  });
});

describe('approvedCouponPatch', () => {
  it('puts the coupon on the ticket exactly as it was approved', () => {
    expect(
      approvedCouponPatch({
        coupon_code: 'SORRY10',
        coupon_value: 25,
        coupon_percent: null,
        compensation: 'Compensated',
      }),
    ).toEqual({
      coupon_code: 'SORRY10',
      coupon_value: 25,
      coupon_percent: null,
      compensation: 'Compensated',
    });
  });

  it('records an approved coupon AS compensation even when the agent left it blank', () => {
    // Otherwise an approved coupon sits on a ticket still claiming the customer
    // got nothing, and every compensation report undercounts.
    expect(
      approvedCouponPatch({
        coupon_code: 'SORRY10',
        coupon_value: 25,
        coupon_percent: null,
        compensation: null,
      }).compensation,
    ).toBe('Compensated');
  });
});

describe('couponRequestProblem', () => {
  it('refuses a request with nothing in it', () => {
    expect(couponRequestProblem(input())).toBe('none-requested');
  });

  it('refuses impossible numbers rather than sending them for approval', () => {
    expect(couponRequestProblem(input({ coupon_value: '-5' }))).toBe('bad-numbers');
    expect(couponRequestProblem(input({ coupon_percent: '120' }))).toBe('bad-numbers');
    expect(couponRequestProblem(input({ coupon_code: 'X', coupon_value: 'abc' }))).toBe(
      'bad-numbers',
    );
  });

  it('accepts a well-formed request', () => {
    expect(couponRequestProblem(input({ coupon_code: 'SORRY10', coupon_value: '25' }))).toBeNull();
    expect(couponRequestProblem(input({ coupon_percent: '100' }))).toBeNull();
  });
});
