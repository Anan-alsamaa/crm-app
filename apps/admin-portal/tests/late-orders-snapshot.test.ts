import { describe, it, expect } from 'vitest';
import {
  snapshotLines,
  snapshotLinesTotal,
  mergeLateOrders,
} from '../src/features/late-orders/api.js';

/**
 * THE STORED ORDER, PRICED PER LINE (owner spec §19, 2026-09-30).
 *
 * `order_snapshot` was written on every late-order decision and read by nothing,
 * so the register could not show what the customer had actually ordered. Reading
 * it back is the whole of §19 — the fetch strategy was already right.
 *
 * `price` in a snapshot is Yiji's `itemPrice`: the price of ONE. Rendering it raw
 * is the money bug the owner caught on the coupon form — three waters at 1 SAR
 * reading "1" while the inbox, which multiplies, read 3. The same field is stored
 * here, so the same rule applies, and it lives in one exported function so the
 * panel and these tests cannot disagree.
 */
describe('snapshotLines', () => {
  it('multiplies quantity by unit price', () => {
    expect(snapshotLines({ items: [{ name: 'Water', qty: 3, price: 1 }] })).toMatchObject([
      { name: 'Water', qty: 3, unit: 1, lineTotal: 3 },
    ]);
  });

  it('leaves a single item at its own price', () => {
    expect(snapshotLines({ items: [{ name: 'Burger', qty: 1, price: 28 }] })).toMatchObject([
      { lineTotal: 28 },
    ]);
  });

  /*
   * A MISSING QUANTITY IS ONE, NOT ZERO. Both appear on real Yiji lines, and a
   * line silently worth nothing is how a plausible wrong total gets read as
   * fact — see [[coupon-rules-and-yiji-ids]], where a 0 SAR coupon was approved.
   */
  it.each([
    ['absent', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -2],
  ])('treats a %s quantity as one', (_label, qty) => {
    expect(snapshotLines({ items: [{ name: 'Fries', qty, price: 9 }] })).toMatchObject([
      { qty: 1, lineTotal: 9 },
    ]);
  });

  it('treats a missing price as zero rather than dropping the line', () => {
    expect(snapshotLines({ items: [{ name: 'Sauce', qty: 4, price: null }] })).toMatchObject([
      { qty: 4, unit: 0, lineTotal: 0 },
    ]);
  });

  /* An unnamed line still renders: the quantity and price are real, and dropping
     it would make the items total disagree with the order total for no visible
     reason. */
  it('names an unnamed line rather than omitting it', () => {
    expect(snapshotLines({ items: [{ qty: 2, price: 5 }] })).toMatchObject([
      { name: '—', lineTotal: 10 },
    ]);
  });

  /*
   * NULL AND EMPTY ARE BOTH NORMAL, and neither may throw: a pending row has no
   * decision so no snapshot, and a handful of decisions predate the column.
   */
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a snapshot with no items', {}],
    ['a snapshot with null items', { items: null }],
  ])('returns no lines for %s', (_label, snap) => {
    expect(snapshotLines(snap)).toEqual([]);
  });

  it('keeps the sku and category when they are there, and drops blanks', () => {
    expect(
      snapshotLines({
        items: [{ name: 'Pasta', qty: 1, price: 40, sku: '77', category: 'Mains' }],
      }),
    ).toMatchObject([{ sku: '77', category: 'Mains' }]);
    expect(
      snapshotLines({ items: [{ name: 'Pasta', qty: 1, price: 40, sku: '  ' }] }),
    ).toMatchObject([{ sku: null, category: null }]);
  });
});

describe('snapshotLinesTotal', () => {
  /* The number a supervisor reads against the coupon. Summing UNIT prices here
     would give 29 for the same order. */
  it('sums the line totals, not the unit prices', () => {
    const lines = snapshotLines({
      items: [
        { name: 'Water', qty: 3, price: 1 },
        { name: 'Burger', qty: 2, price: 28 },
      ],
    });
    expect(snapshotLinesTotal(lines)).toBe(59);
  });

  it('is zero for an empty order', () => {
    expect(snapshotLinesTotal([])).toBe(0);
  });
});

/**
 * A PENDING ROW CARRIES NO SNAPSHOT, and that is the truth rather than a gap:
 * nobody has acted on the order, so nothing was ever captured. The panel must be
 * able to tell that apart from a decided row whose capture failed — both render
 * the same "not captured" message, but the field must exist either way so the
 * merge cannot produce a row the panel chokes on.
 */
describe('mergeLateOrders and the snapshot field', () => {
  it('gives a queue-only row a null snapshot', () => {
    const merged = mergeLateOrders(
      [],
      [{ orderId: '1325235', status: 'canceled', minutesElapsed: 61 } as never],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ state: 'pending', pendingOnly: true, order_snapshot: null });
  });

  it('keeps a decision row own snapshot through the merge', () => {
    const snap = { orderId: '1', items: [{ name: 'Water', qty: 3, price: 1 }] };
    const merged = mergeLateOrders(
      [
        {
          id: 'd1',
          order_id: '1',
          kind: 'late_delivery',
          action: 'compensated',
          reason: 'r',
          minutes_elapsed: 90,
          brand_name: null,
          restaurant_name: null,
          date_created: '2026-09-30T10:00:00',
          decided_by: null,
          ticket: null,
          order_snapshot: snap,
        } as never,
      ],
      [],
    );
    expect(merged[0]?.order_snapshot).toEqual(snap);
    // And the lines price correctly straight off the merged row.
    expect(snapshotLinesTotal(snapshotLines(merged[0]?.order_snapshot))).toBe(3);
  });
});
