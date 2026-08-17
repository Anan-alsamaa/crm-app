import { describe, it, expect } from 'vitest';
import {
  couponOutcomes,
  couponOutcomesByAgent,
  couponRate,
  type CouponApprovalFact,
} from '../src/coupon-approvals.js';

const f = (
  status: string | null,
  editedByAdmin = false,
  requestedById: string | null = 'a1',
  requestedByName: string | null = 'Saad',
): CouponApprovalFact => ({ status, editedByAdmin, requestedById, requestedByName });

describe('couponOutcomes', () => {
  it('separates an amended approval from a straight one', () => {
    // Both went through; only one went through as asked. Collapsing them would
    // hide the thing the report exists to show.
    const o = couponOutcomes([f('approved'), f('approved', true), f('rejected'), f('pending')]);
    expect(o).toMatchObject({
      requested: 4,
      approvedAsAsked: 1,
      approvedWithChanges: 1,
      approvedTotal: 2,
      rejected: 1,
      pending: 1,
    });
  });

  it('counts an unrecognised status as undecided rather than dropping it', () => {
    // A request that vanishes from the totals is worse than one in the wrong
    // bucket: the columns stop adding up and nobody trusts the page again.
    const o = couponOutcomes([f('escalated'), f(null)]);
    expect(o.requested).toBe(2);
    expect(o.pending).toBe(2);
  });

  it('adds up', () => {
    const o = couponOutcomes([f('approved'), f('approved', true), f('rejected'), f(null)]);
    expect(o.approvedTotal + o.rejected + o.pending).toBe(o.requested);
    expect(o.approvedAsAsked + o.approvedWithChanges).toBe(o.approvedTotal);
  });
});

describe('couponOutcomesByAgent', () => {
  it('keeps unassigned requests visible so the rows still sum to the total', () => {
    const facts = [f('approved'), f('rejected', false, null, null)];
    const rows = couponOutcomesByAgent(facts);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((n, r) => n + r.requested, 0)).toBe(couponOutcomes(facts).requested);
  });

  it('never leaves a row without a name', () => {
    const rows = couponOutcomesByAgent([f('approved', false, 'a9', '   ')], 'Unknown');
    // Falls back to the id, then to the label — ugly beats anonymous, because a
    // row nobody can identify cannot be acted on.
    expect(rows[0]!.agentName).toBe('a9');
    expect(couponOutcomesByAgent([f('approved', false, null, null)], 'Unknown')[0]!.agentName).toBe(
      'Unknown',
    );
  });

  it('puts the busiest agent first', () => {
    const rows = couponOutcomesByAgent([
      f('approved', false, 'a1', 'Saad'),
      f('approved', false, 'a2', 'Nouf'),
      f('rejected', false, 'a2', 'Nouf'),
    ]);
    expect(rows.map((r) => r.agentName)).toEqual(['Nouf', 'Saad']);
  });
});

describe('couponRate', () => {
  it('is a share of what has been DECIDED, not of everything asked for', () => {
    // Two approved, one rejected, six still queued. The approval rate is 67%,
    // not 22% — queued requests are not refusals, and dividing by the total
    // makes the rate appear to collapse as volume rises.
    const o = couponOutcomes([
      f('approved'),
      f('approved'),
      f('rejected'),
      ...Array.from({ length: 6 }, () => f('pending')),
    ]);
    expect(couponRate(o.approvedTotal, o)).toBeCloseTo(66.67, 1);
  });

  it('is null when nothing has been decided, because 0% would be a lie', () => {
    const o = couponOutcomes([f('pending'), f('pending')]);
    expect(couponRate(o.approvedTotal, o)).toBeNull();
  });

  it('reaches 100 when everything decided went through', () => {
    const o = couponOutcomes([f('approved'), f('approved', true)]);
    expect(couponRate(o.approvedTotal, o)).toBe(100);
  });
});
