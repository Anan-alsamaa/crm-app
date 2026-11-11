import { describe, expect, it } from 'vitest';
import {
  breakdownBasis,
  buildOrderBreakdown,
  collapseGroupOrders,
  groupBelongsTo,
  groupOrderIds,
  groupRoleOf,
  toGroupSuborder,
  type OrderGroup,
} from '../src/order-group.js';

/* Real prod shapes (2026-11-11): master 1370742, suborders 1370743/1370744. */
const sub = (id: number, rest: number, brand: string) =>
  toGroupSuborder({
    id,
    restaurantId: rest,
    brandId: 3,
    restaurantName: `R${rest}`,
    brandName: brand,
  })!;
const group: OrderGroup = {
  masterId: '1370742',
  enteredId: '1370743',
  restaurantGroupId: 12,
  customerPhone: '0555000111',
  suborders: [sub(1370743, 183, 'Okashi'), sub(1370744, 177, 'Taker')],
};

describe('groupRoleOf', () => {
  it('a master has a restaurant group and no master of its own', () => {
    expect(
      groupRoleOf({ id: 1370742, restaurantGroupId: 12, restaurantGroupOrderId: null }),
    ).toEqual({
      role: 'master',
      masterId: '1370742',
    });
  });
  it('a suborder points at its master', () => {
    expect(
      groupRoleOf({ id: 1370743, restaurantGroupId: 12, restaurantGroupOrderId: 1370742 }),
    ).toEqual({
      role: 'sub',
      masterId: '1370742',
    });
  });
  it('an ordinary order is neither', () => {
    expect(
      groupRoleOf({ id: 1372248, restaurantGroupId: null, restaurantGroupOrderId: null }),
    ).toBeNull();
    expect(groupRoleOf(null)).toBeNull();
  });
});

describe('buildOrderBreakdown', () => {
  it('splits an Amount coupon in equal halves on the suborders (32 -> 16 + 16)', () => {
    const b = buildOrderBreakdown(
      group,
      breakdownBasis({ discount_category: 'Amount', coupon_value: 32 })!,
    );
    expect(b?.master_order_id).toBe('1370742');
    expect(b?.basis).toBe('amount');
    expect(b?.lines.map((l) => [l.order_id, l.share])).toEqual([
      ['1370743', 16],
      ['1370744', 16],
    ]);
  });
  it('never rounds: 5 over three suborders is exactly 5 / 3 each, as Yiji stores it', () => {
    const three = { ...group, suborders: [...group.suborders, sub(1370745, 190, 'X')] };
    const b = buildOrderBreakdown(three, { basis: 'amount', amount: 5 })!;
    for (const l of b.lines) expect(l.share).toBe(5 / 3);
  });
  it('splits a Percentage coupon by its maximum discount', () => {
    expect(
      breakdownBasis({ discount_category: 'Percentage', coupon_value: 20, max_discount: 50 }),
    ).toEqual({
      basis: 'max_discount',
      amount: 50,
    });
  });
  it('is no breakdown with fewer than two suborders, or nothing to split', () => {
    expect(
      buildOrderBreakdown(
        { ...group, suborders: [group.suborders[0]!] },
        { basis: 'amount', amount: 10 },
      ),
    ).toBeNull();
    expect(breakdownBasis({ discount_category: 'Amount', coupon_value: 0 })).toBeNull();
  });
  it('never lists the master as one of its own suborders', () => {
    const odd = { ...group, suborders: [...group.suborders, sub(1370742, 183, 'Okashi')] };
    expect(buildOrderBreakdown(odd, { basis: 'amount', amount: 32 })!.lines).toHaveLength(2);
  });
});

describe('groupBelongsTo', () => {
  it('applies a group only to its own customer, in any phone format', () => {
    expect(groupBelongsTo(group, '+966555000111')).toBe(true);
    expect(groupBelongsTo(group, null, '0555000111')).toBe(true);
    expect(groupBelongsTo(group, '0500000000')).toBe(false);
    expect(groupBelongsTo({ customerPhone: null }, '0555000111')).toBe(false);
  });
});

it('groupOrderIds lists the master first, then the suborders', () => {
  expect(groupOrderIds(group)).toEqual(['1370742', '1370743', '1370744']);
});

describe('collapseGroupOrders', () => {
  const list = [
    { orderId: '1370744', groupRole: 'sub' as const, groupMasterId: '1370742' },
    { orderId: '1370743', groupRole: 'sub' as const, groupMasterId: '1370742' },
    { orderId: '1370742', groupRole: 'master' as const, groupMasterId: '1370742' },
    { orderId: '1365709' },
    { orderId: '1300001', groupRole: 'sub' as const, groupMasterId: '1300000' },
  ];
  it('shows a group order once, as its master, with its suborders inside', () => {
    const out = collapseGroupOrders(list);
    expect(out.map((o) => o.orderId)).toEqual(['1370742', '1365709', '1300001']);
    expect(out[0]!.groupSuborders?.map((s) => s.orderId)).toEqual(['1370744', '1370743']);
  });
  it('keeps a suborder whose master is not in the list', () => {
    expect(collapseGroupOrders([list[4]!]).map((o) => o.orderId)).toEqual(['1300001']);
  });
});
