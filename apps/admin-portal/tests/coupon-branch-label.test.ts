import { describe, it, expect } from 'vitest';
import { buildStoreIndex } from '@yiji/shared-types';
import { branchLabel } from '../src/features/coupon-approvals/CouponApprovalsPage.js';

/**
 * A SUPERVISOR APPROVES A BRANCH, NOT AN ID (owner spec §18, 2026-09-29).
 *
 * The approvals card had two branch lines and both were wrong for a coupon
 * raised from the LATE-ORDERS queue. That coupon has no ticket with a store —
 * the queue knows Yiji's ids and nothing else — so the branch at the top read
 * "—" while the detail panel below printed `brand_id` and `restaurant_id` raw.
 * Both said the same thing badly: we know which branch this is, and we are
 * showing the machine's word for it.
 *
 * The store master already maps Yiji's restaurant id to a name; nothing was
 * missing but the lookup.
 */
const index = buildStoreIndex([
  {
    id: 's1',
    code: 'NRJ',
    name: 'Narjis',
    city: 'Riyadh',
    brandName: 'Okashi',
    brandYijiName: 'Okashi',
    yijiRestaurantId: '4417',
  } as never,
]);

const base = { ticket: null, brand_id: null, restaurant_id: null };

describe('branchLabel', () => {
  /* The ticket's own store wins: it is the branch the complaint was filed
     against, which is a stronger statement than an id lookup. */
  it("prefers the ticket's store", () => {
    expect(
      branchLabel(
        {
          ...base,
          ticket: { store: { name: 'Narjis', brand: { name: 'Okashi' } } } as never,
          restaurant_id: '4417',
        },
        index,
      ),
    ).toBe('Okashi · Narjis');
  });

  /* THE FIX. No ticket store — a late-order coupon — so the name comes from the
     master, keyed by the id the coupon does carry. */
  it('resolves the name from the store master when there is no ticket', () => {
    expect(branchLabel({ ...base, restaurant_id: '4417' }, index)).toBe('Okashi · Narjis');
  });

  it('tolerates a padded id, which is how ids arrive from a text column', () => {
    expect(branchLabel({ ...base, restaurant_id: ' 4417 ' }, index)).toBe('Okashi · Narjis');
  });

  /*
   * AN UNMAPPED STORE SHOWS ITS IDS rather than an em dash. That branch is
   * missing from the master and somebody has to chase it — an id they can
   * search for beats a dash that hides the gap.
   */
  it('falls back to the ids when the master does not have the branch', () => {
    expect(branchLabel({ ...base, brand_id: '7', restaurant_id: '9999' }, index)).toBe('7 · 9999');
  });

  it('is null when there is genuinely nothing to show', () => {
    expect(branchLabel(base, index)).toBeNull();
  });

  /* The index can be absent on first paint, before the master has loaded. That
     must not throw and must not lose the ids. */
  it('survives a missing index', () => {
    expect(branchLabel({ ...base, restaurant_id: '4417' }, null)).toBe('4417');
    expect(branchLabel(base, null)).toBeNull();
  });
});
