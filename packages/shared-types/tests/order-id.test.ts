import { describe, it, expect } from 'vitest';
import { normalizeOrderId, withNormalizedOrderId } from '../src/order-id.js';

/* 2026-10-12: the 5 Oct import wrote order "0" on 25 tickets, and the inbox
   asked Yiji for order 0 ~48 times a day. Blank or all-zero = no order. */
describe('normalizeOrderId', () => {
  it.each([[null], [undefined], [''], ['  '], ['0'], ['000'], [0]])('%j is no order', (v) => {
    expect(normalizeOrderId(v)).toBeNull();
  });
  it('keeps a real order number, trimmed', () => {
    expect(normalizeOrderId(' 1340626 ')).toBe('1340626');
    expect(normalizeOrderId(1340626)).toBe('1340626');
    expect(normalizeOrderId('1300')).toBe('1300');
  });
  it('touches a payload only when it carries order_id', () => {
    expect(withNormalizedOrderId({ subject: 'x' })).toEqual({ subject: 'x' });
    expect(withNormalizedOrderId({ order_id: '0', subject: 'x' })).toEqual({
      order_id: null,
      subject: 'x',
    });
  });
});
