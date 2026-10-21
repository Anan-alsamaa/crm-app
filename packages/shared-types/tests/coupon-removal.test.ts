import { describe, expect, it } from 'vitest';
import {
  CouponRemoveJob,
  couponCountsAsCompensation,
  couponIsRemoved,
  effectivePrivileges,
  PRIVILEGE_PORTAL,
  ticketCompensationFor,
} from '../src/index.js';

/** EMA-80 (owner, 2026-10-21): a ticket's Compensation follows its coupons. */
describe('which coupons make a ticket Compensated', () => {
  it('counts a request from the moment it exists, pending included', () => {
    for (const status of ['pending', 'approved', 'edited', 'assigned']) {
      expect(couponCountsAsCompensation({ status }), status).toBe(true);
    }
  });

  it('does not count a rejected or a removed coupon', () => {
    expect(couponCountsAsCompensation({ status: 'rejected' })).toBe(false);
    expect(couponCountsAsCompensation({ status: 'assigned', removal_status: 'removed' })).toBe(
      false,
    );
    expect(couponCountsAsCompensation({ status: 'pending', removal_status: 'not_on_yiji' })).toBe(
      false,
    );
  });

  it('still counts a coupon that was used, failed to go, or is being removed', () => {
    for (const removal_status of ['used', 'failed', 'pending']) {
      expect(couponIsRemoved({ removal_status })).toBe(false);
      expect(couponCountsAsCompensation({ status: 'assigned', removal_status })).toBe(true);
    }
  });

  it('the ticket is Not Compensated only when no coupon counts', () => {
    expect(ticketCompensationFor([])).toBe('Not Compensated');
    expect(ticketCompensationFor([{ status: 'assigned', removal_status: 'removed' }])).toBe(
      'Not Compensated',
    );
    expect(
      ticketCompensationFor([
        { status: 'assigned', removal_status: 'removed' },
        { status: 'approved', removal_status: null },
      ]),
    ).toBe('Compensated');
  });
});

describe('manage_ticket_compensation — WeCare Admin / Supervisor only', () => {
  const ADMIN = { approve_coupons: true, create_tickets: true, use_chat: true };
  const AGENT = { create_tickets: true, use_chat: true };
  it('defaults on for the roles that decide coupons, off for everyone else', () => {
    expect(effectivePrivileges(ADMIN, 'WeCare Admin').manage_ticket_compensation).toBe(true);
    expect(effectivePrivileges(ADMIN, 'WeCare Supervisor').manage_ticket_compensation).toBe(true);
    expect(effectivePrivileges(AGENT, 'WeCare Agent').manage_ticket_compensation).toBe(false);
    expect(effectivePrivileges({}, 'Viewer').manage_ticket_compensation).toBe(false);
  });

  it('a stored switch wins either way', () => {
    expect(
      effectivePrivileges({ ...ADMIN, manage_ticket_compensation: false }, 'WeCare Supervisor')
        .manage_ticket_compensation,
    ).toBe(false);
    expect(
      effectivePrivileges({ ...AGENT, manage_ticket_compensation: true }, 'WeCare Agent')
        .manage_ticket_compensation,
    ).toBe(true);
  });

  it('sits in the agent portal on the Roles page', () => {
    expect(PRIVILEGE_PORTAL.manage_ticket_compensation).toBe('agent');
  });
});

describe('CouponRemoveJob', () => {
  it('requires a coupon, who, and a reason', () => {
    expect(
      CouponRemoveJob.safeParse({ couponApprovalId: 'c', removedBy: 'u', reason: 'refund' })
        .success,
    ).toBe(true);
    expect(
      CouponRemoveJob.safeParse({ couponApprovalId: 'c', removedBy: 'u', reason: '  ' }).success,
    ).toBe(false);
    // The gateway parses the body WITHOUT removedBy - the caller cannot name it.
    const body = CouponRemoveJob.omit({ removedBy: true }).parse({
      couponApprovalId: 'c',
      reason: 'x',
      removedBy: 'spoofed',
    });
    expect(body).not.toHaveProperty('removedBy');
  });
});
