import { describe, it, expect } from 'vitest';
import { pickableLines, pickedTotal } from '../src/features/coupons/CouponRequestDialog.js';

/**
 * AN ITEM'S PRICE IS PER UNIT (owner, 2026-09-29).
 *
 * Yiji's `itemPrice` is what ONE costs. The coupon dialog rendered it raw, so a
 * line of 3 waters at 1 SAR showed "1" beside the item while the inbox's order
 * panel — which multiplies — showed 3. The owner spotted exactly that: same
 * order, two numbers.
 *
 * The display was the smaller half. The sum of the picked lines is what fills
 * the coupon's VALUE field, so the coupon was under-filled by a factor of the
 * quantity, and it looked right: a plausible number, no error, nothing to
 * notice. See [[silent-empty-failures]] for the shape.
 *
 * Pinned on the exported arithmetic rather than the rendering: this is a money
 * path, and what matters is the number, not the markup around it.
 */
describe('a picked line is worth quantity × unit price', () => {
  it('multiplies — the reported case, 3 waters at 1 SAR', () => {
    const lines = pickableLines([{ name: 'Water', price: 1, qty: 3 }]);
    expect(lines).toMatchObject([{ unit: 1, qtyN: 3, lineTotal: 3 }]);
  });

  it('leaves a single item at its own price', () => {
    expect(pickableLines([{ name: 'Burger', price: 28, qty: 1 }])).toMatchObject([
      { lineTotal: 28 },
    ]);
  });

  /*
   * A MISSING QUANTITY IS ONE, not zero. Both appear on real Yiji lines, and a
   * line silently worth nothing is how a coupon gets approved for 0 SAR — which
   * has happened here before, see [[coupon-rules-and-yiji-ids]].
   */
  it.each([
    ['absent', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -2],
  ])('treats a %s quantity as one', (_label, qty) => {
    expect(pickableLines([{ name: 'Fries', price: 9, qty }])).toMatchObject([{ lineTotal: 9 }]);
  });

  it('treats a missing price as zero rather than dropping the line', () => {
    expect(pickableLines([{ name: 'Sauce', price: null, qty: 4 }])).toMatchObject([
      { lineTotal: 0 },
    ]);
  });

  /* De-duplicated by name, because the name is the key the coupon row stores —
     and the surviving row must keep its own quantity, not collapse to one. */
  it('offers a repeated name once', () => {
    const lines = pickableLines([
      { name: 'Water', price: 1, qty: 3 },
      { name: 'Water', price: 1, qty: 3 },
    ]);
    expect(lines).toMatchObject([{ lineTotal: 3 }]);
  });

  /*
   * THE NUMBER THAT REACHES THE COUPON. This is the one the owner's report was
   * really about: the value field is filled from this sum.
   */
  it('sums the picked lines by line total, not by unit price', () => {
    const lines = pickableLines([
      { name: 'Water', price: 1, qty: 3 },
      { name: 'Burger', price: 28, qty: 2 },
      { name: 'Cake', price: 15, qty: 1 },
    ]);
    // 3 + 56 = 59. Summing unit prices would have given 29.
    expect(pickedTotal(lines, new Set(['Water', 'Burger']))).toBe(59);
    expect(pickedTotal(lines, new Set(['Water', 'Burger', 'Cake']))).toBe(74);
  });

  it('is zero when nothing is picked', () => {
    const lines = pickableLines([{ name: 'Water', price: 1, qty: 3 }]);
    expect(pickedTotal(lines, new Set())).toBe(0);
  });

  /* A name that is not on the order cannot contribute — the selection is a set
     of strings parsed back out of one text column, so a stale name is possible. */
  it('ignores a selected name the order does not have', () => {
    const lines = pickableLines([{ name: 'Water', price: 1, qty: 3 }]);
    expect(pickedTotal(lines, new Set(['Water', 'Ghost']))).toBe(3);
  });
});
