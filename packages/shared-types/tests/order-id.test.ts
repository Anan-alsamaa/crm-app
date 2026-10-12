import { describe, it, expect } from 'vitest';
import { normalizeOrderId, orderLabel } from '../src/order-id.js';

/* Owner, 2026-10-12: where there is no order it says "-". Display only:
   stored tickets keep exactly what was saved. */
describe('order number display', () => {
  it.each([[null], [undefined], [''], ['  '], ['0'], ['000'], [0]])('%j shows "-"', (v) => {
    expect(normalizeOrderId(v)).toBeNull();
    expect(orderLabel(v)).toBe('-');
  });
  it('shows a real order number, trimmed', () => {
    expect(orderLabel(' 1340626 ')).toBe('1340626');
    expect(orderLabel(1340626)).toBe('1340626');
    expect(orderLabel('1300')).toBe('1300');
  });
});
