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
    expect(lateOrderState({ action: 'commented', reason: 'kitchen was backed up' })).toBe(
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
    expect(lateOrderState({ action: 'commented', reason: 'chased the branch' })).not.toBe(
      'handled',
    );
  });

  /*
   * `ignored` IS GONE FROM THE DATA, not just from the vocabulary. The one
   * historical row on production was MIGRATED to `commented` (owner,
   * 2026-09-29) rather than left as a legacy spelling to interpret forever.
   *
   * Still mapped defensively: an unrecognised action with a reason is somebody
   * having looked and written something down, which is what `commented` means.
   * A row arriving from an older client must not read as `pending` and invite
   * a second look at work already done.
   */
  it('treats any unrecognised action with a reason as commented', () => {
    expect(lateOrderState({ action: 'ignored', reason: 'duplicate order' })).toBe('commented');
    expect(lateOrderState({ action: 'whatever', reason: 'looked at it' })).toBe('commented');
  });

  /* A decision with no reason at all is not a comment — there is nothing to
     show anybody. */
  it.each([
    ['null reason', null],
    ['empty', ''],
    ['whitespace', '   '],
  ])('is pending for a decision with a %s reason', (_label, reason) => {
    expect(lateOrderState({ action: 'commented', reason })).toBe('pending');
  });

  /* Compensated wins even with no reason: the coupon is the fact. */
  it('is handled even when the compensation carries no reason', () => {
    expect(lateOrderState({ action: 'compensated', reason: null })).toBe('handled');
  });
});
