import { describe, expect, it } from 'vitest';
import { lateOrderState } from '../src/late-delivery.js';

/**
 * PENDING → COMMENTED → HANDLED (owner, 2026-09-29).
 *
 * This is the LATE ORDER HANDLING state, and it is not the order's own status.
 * An order can be `delivered` or `force_closed` upstream and still be `pending`
 * here, because nobody at WeCare has touched it.
 *
 * ONE function answers it, so the queue, the register and the summary cannot
 * disagree about what "handled" means.
 */
describe('lateOrderState', () => {
  it('is pending when nothing has been recorded', () => {
    expect(lateOrderState(null)).toBe('pending');
    expect(lateOrderState(undefined)).toBe('pending');
  });

  it('is commented when a reason was written but no coupon given', () => {
    expect(lateOrderState({ action: 'ignored', reason: 'kitchen was backed up' })).toBe(
      'commented',
    );
  });

  it('is handled once a coupon is assigned', () => {
    expect(lateOrderState({ action: 'compensated', reason: 'gave 20 SAR' })).toBe('handled');
  });

  /*
   * A COMMENT IS NOT A RESOLUTION. The customer has had nothing; somebody has
   * merely written down what they found. Only a coupon closes it.
   */
  it('a comment does not make it handled', () => {
    expect(lateOrderState({ action: 'ignored', reason: 'chased the branch' })).not.toBe('handled');
  });

  /*
   * LEGACY `ignored` ROWS READ AS COMMENTED. "Ignore" used to file a decision
   * saying nothing had been done; those rows carry a real reason somebody
   * typed, so they are comments. Nothing is rewritten and nothing vanishes
   * from a report.
   */
  it('reads a legacy ignored row as commented', () => {
    expect(lateOrderState({ action: 'ignored', reason: 'duplicate order' })).toBe('commented');
  });

  /* A decision with no reason at all is not a comment — there is nothing to
     show anybody. */
  it.each([
    ['null reason', null],
    ['empty', ''],
    ['whitespace', '   '],
  ])('is pending for a decision with a %s reason', (_label, reason) => {
    expect(lateOrderState({ action: 'ignored', reason })).toBe('pending');
  });

  /* Compensated wins even with no reason: the coupon is the fact. */
  it('is handled even when the compensation carries no reason', () => {
    expect(lateOrderState({ action: 'compensated', reason: null })).toBe('handled');
  });
});
