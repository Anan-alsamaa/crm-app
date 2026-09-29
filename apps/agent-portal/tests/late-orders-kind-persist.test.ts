import { describe, it, expect, beforeEach } from 'vitest';
import { readStoredKinds, writeStoredKinds } from '../src/features/late-orders/LateOrdersPage.js';

/**
 * THE CHOSEN CAUSE MUST SURVIVE A RELOAD (owner, 2026-09-29).
 *
 * The dropdown was component state, so an agent who set "Late preparation" and
 * came back found it reading "Late delivery" again. That is not a display
 * glitch: the dropdown is a DECISION being prepared, and losing it means the
 * next coupon or ticket is filed under the wrong cause with nobody told.
 *
 * `localStorage`, not `sessionStorage` — the sessions here are per-tab so two
 * agents can share a machine, but how an ORDER is classified is not a per-tab
 * fact.
 */
const KEY = 'yiji.lateOrders.kinds';

beforeEach(() => localStorage.clear());

describe('the chosen cause persists', () => {
  it('reads back what was written', () => {
    writeStoredKinds({ '1323291': 'late_preparation' });
    expect(readStoredKinds()).toEqual({ '1323291': 'late_preparation' });
  });

  it('starts empty rather than throwing when nothing is stored', () => {
    expect(readStoredKinds()).toEqual({});
  });

  /*
   * A CORRUPT VALUE MUST NOT BREAK THE PAGE. Anything can end up in
   * `localStorage` — another tab, an extension, a half-written value — and a
   * queue that refuses to render because a string was malformed is worse than
   * one that forgets a classification.
   */
  it.each([
    ['not json', '{oops'],
    ['an array', '[1,2,3]'],
    ['a bare string', '"late_delivery"'],
    ['null', 'null'],
  ])('ignores %s and returns an empty map', (_label, raw) => {
    localStorage.setItem(KEY, raw);
    expect(readStoredKinds()).toEqual({});
  });

  /* Non-string entries are dropped rather than handed to the dropdown, which
     would render an object as a value. */
  it('keeps only string values', () => {
    localStorage.setItem(KEY, JSON.stringify({ a: 'late_delivery', b: 42, c: null, d: '' }));
    expect(readStoredKinds()).toEqual({ a: 'late_delivery' });
  });

  /*
   * CAPPED, so a browser does not carry every order the agent has ever looked
   * at. The newest are kept: the tail of an object's insertion order is the
   * most recently classified.
   */
  it('keeps the most recent 500 and discards older ones', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 600; i++) many[`order-${i}`] = 'late_delivery';
    writeStoredKinds(many);

    const back = readStoredKinds();
    expect(Object.keys(back)).toHaveLength(500);
    // The last one written survives; the first is gone.
    expect(back['order-599']).toBe('late_delivery');
    expect(back['order-0']).toBeUndefined();
  });

  it('does not throw when storage refuses the write', () => {
    const original = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      expect(() => writeStoredKinds({ x: 'late_delivery' })).not.toThrow();
    } finally {
      localStorage.setItem = original;
    }
  });
});
