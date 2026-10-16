import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/directus.js', () => ({ directus: { request: vi.fn() } }));
vi.mock('../src/lib/commerce-client.js', () => ({ commerce: {} }));

import { decisionsByOrder } from '../src/features/late-orders/api.js';

const row = (id: string, action: string, at: string) => ({
  id,
  order_id: '1323407',
  action,
  kind: 'late driver',
  reason: id,
  action_taken: null,
  ticket: null,
  date_created: at,
});

/*
 * Owner, 2026-10-16: order 1323407 was compensated on 29 Sep; a comment typed
 * today filed a SECOND decision and the screen then showed the comment, hiding
 * the coupon. One decision per order, and a compensation is never hidden.
 */
describe('late-order decisions: one per order', () => {
  it('a compensation wins over a later comment', () => {
    const m = decisionsByOrder([
      row('comment', 'commented', '2026-10-16T09:22:28Z'),
      row('coupon', 'compensated', '2026-09-29T12:04:14Z'),
    ]);
    expect(m.get('1323407')?.id).toBe('coupon');
  });
  it('within the same action the newest wins', () => {
    const m = decisionsByOrder([
      row('old', 'commented', '2026-10-01T10:00:00Z'),
      row('new', 'commented', '2026-10-02T10:00:00Z'),
    ]);
    expect(m.get('1323407')?.id).toBe('new');
  });
});
