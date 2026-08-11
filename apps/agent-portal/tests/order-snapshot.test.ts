import { describe, it, expect } from 'vitest';
import {
  parseLegacyOrderBlock,
  orderToSnapshot,
} from '../src/features/tickets/OrderSnapshotCard.js';
import type { YijiOrder } from '@yiji/shared-types';

/**
 * Tickets created before `tickets.order_snapshot` existed stored the order as
 * prose in the description. The parser recovers the order id so the ticket can
 * re-fetch and render a real card, and returns the description with that block
 * stripped. It keys off the `#<id> ·` line because the surrounding labels are
 * translated (EN/AR) and therefore unreliable.
 */
describe('parseLegacyOrderBlock', () => {
  it('recovers the order id and strips the block (real ticket content)', () => {
    const description = [
      'Order from this chat:',
      '#946641 · Closed',
      'Deliver to: 3184 Al Imam Abdullah Bin Saud Bin Abdulaziz Road - حي المروج, الرياض, RHGA3184, Saudi Arabia,SA',
      'Total: SAR 26.00',
    ].join('\n');

    const parsed = parseLegacyOrderBlock(description);
    expect(parsed?.orderId).toBe('946641');
    // The whole block, including its label line, is removed.
    expect(parsed?.description).toBe('');
  });

  it("keeps the agent's own text and removes only the order block", () => {
    const description = [
      'Customer says the order never arrived.',
      'Asked them to confirm the address.',
      '',
      'Order from this chat:',
      '#5921 · In Delivery',
      'Total: SAR 84.50',
      'Items:',
      '  2× Classic cheeseburger',
    ].join('\n');

    const parsed = parseLegacyOrderBlock(description);
    expect(parsed?.orderId).toBe('5921');
    expect(parsed?.description).toBe(
      'Customer says the order never arrived.\nAsked them to confirm the address.',
    );
  });

  it('works with a translated (Arabic) label line', () => {
    const parsed = parseLegacyOrderBlock(['الطلب من هذه المحادثة:', '#42 · مغلق'].join('\n'));
    expect(parsed?.orderId).toBe('42');
    expect(parsed?.description).toBe('');
  });

  it('returns null for a description with no order block', () => {
    expect(parseLegacyOrderBlock('Just a normal ticket description.')).toBeNull();
    expect(parseLegacyOrderBlock('')).toBeNull();
    expect(parseLegacyOrderBlock(null)).toBeNull();
    expect(parseLegacyOrderBlock(undefined)).toBeNull();
  });

  it('does not mistake a plain hash for an order line', () => {
    // No ` · ` separator, so this is prose — not the generated block.
    expect(parseLegacyOrderBlock('See #12345 for details')).toBeNull();
  });
});

describe('orderToSnapshot', () => {
  it('carries every displayed field across and drops absent optionals', () => {
    const order: YijiOrder = {
      orderId: '946641',
      status: 'closed',
      total: 26,
      currency: 'SAR',
      placedAt: '2026-06-25T12:25:32.483926',
      items: [{ sku: 'X', name: 'Vegetable Pasta', qty: 1, price: 26, category: 'Original Pasta' }],
      brandName: 'La Casa Pasta',
      restaurantName: 'Riyadh - Masief Plaza',
      restaurantId: '312',
      deliveryType: 'carhop',
      paymentStatus: 'paid',
      paymentMode: 'apple_pay',
    };

    const snap = orderToSnapshot(order);
    expect(snap).toMatchObject({
      orderId: '946641',
      status: 'closed',
      total: 26,
      currency: 'SAR',
      brandName: 'La Casa Pasta',
      restaurantName: 'Riyadh - Masief Plaza',
      // The ONLY stable key between an order and the operations store list.
      // It exists solely on the single-order endpoint, so a ticket that fails
      // to capture it can never be joined by id — only by fuzzy name match.
      restaurantId: '312',
      deliveryType: 'carhop',
      paymentStatus: 'paid',
      paymentMode: 'apple_pay',
    });
    expect(snap.items).toEqual([
      { name: 'Vegetable Pasta', qty: 1, price: 26, category: 'Original Pasta' },
    ]);
    // Optionals the order didn't carry must not appear as undefined keys.
    expect('deliveryAddress' in snap).toBe(false);
  });
});
