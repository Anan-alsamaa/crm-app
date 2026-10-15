import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compensatedItem,
  isUndecided,
  lateOrderKey,
  noteCell,
} from '../src/features/coupon-approvals/compensation-cells.js';

/*
 * EMPTY CELLS ON THE COMPENSATION REPORT (owner, 2026-10-15).
 *
 * On prod 17 of 30 coupons had no Item, 29 no Note, and the one pending row no
 * Approved by / Date. Each case below is a real prod shape.
 */
const labels = { pending: 'Pending', noNote: 'No note' };

describe('Item', () => {
  it('keeps the item the agent picked', () => {
    expect(compensatedItem({ item_name: 'Chicken Pasta' })).toBe('Chicken Pasta');
  });

  it('names a saved sku from the ticket order (prod fe68d208: sku, no name)', () => {
    expect(
      compensatedItem({
        item_name: null,
        item_sku: '44872',
        ticket: {
          order_snapshot: {
            items: [
              { sku: '44867', name: 'Chicken Pasta' },
              { sku: '44872', name: 'Plain Pasta' },
            ],
          },
        },
      }),
    ).toBe('Plain Pasta');
  });

  it("falls back to the ticket order's items, each once (prod a26731e4)", () => {
    expect(
      compensatedItem({
        item_name: null,
        ticket: {
          order_snapshot: {
            items: [
              { sku: '44746', name: 'Combo Chicken Tikka Masala' },
              { sku: '44746', name: 'Combo Chicken Tikka Masala' },
              { sku: '44862', name: 'Greek Salad' },
            ],
          },
        },
      }),
    ).toBe('Combo Chicken Tikka Masala, Greek Salad');
  });

  it("uses the late-order decision's snapshot for a ticketless coupon (prod f15e58ba)", () => {
    const row = { item_name: null, order_id: '1343745', ticket: null };
    expect(lateOrderKey(row)).toBe('1343745');
    expect(compensatedItem(row, { items: [{ name: 'Chicken Pasta' }] })).toBe('Chicken Pasta');
  });

  it('asks for no late decision when the row already has its item or lines', () => {
    expect(lateOrderKey({ item_name: 'X', order_id: '1' })).toBeNull();
    expect(
      lateOrderKey({ item_name: null, ticket: { order_id: '1', order_snapshot: { items: [{}] } } }),
    ).toBeNull();
  });

  it('is empty only when there is no item and no order anywhere', () => {
    expect(compensatedItem({ item_name: null, ticket: null }, null)).toBe('');
  });
});

describe('Note / Approved by / Date', () => {
  it('shows the supervisor note, then the withhold reason', () => {
    expect(noteCell({ status: 'assigned', decision_note: 'ok' }, labels)).toBe('ok');
    expect(
      noteCell(
        { status: 'approved', decision_note: null, delivery_excluded_reason: 'refunded' },
        labels,
      ),
    ).toBe('refunded');
  });

  it('says "No note" for a decision taken without one, "Pending" before one', () => {
    expect(noteCell({ status: 'assigned', decision_note: null }, labels)).toBe('No note');
    expect(noteCell({ status: 'pending', decision_note: '  ' }, labels)).toBe('Pending');
  });

  it('treats only an undecided coupon as pending', () => {
    expect(isUndecided({ status: 'pending' })).toBe(true);
    expect(isUndecided({ status: 'assigned' })).toBe(false);
    expect(isUndecided({ status: 'rejected' })).toBe(false);
  });
});

describe('the page uses them (screen and CSV share column.get)', () => {
  const src = readFileSync(
    [
      'src/features/coupon-approvals/AllCompensationPage.tsx',
      'apps/admin-portal/src/features/coupon-approvals/AllCompensationPage.tsx',
    ]
      .map((r) => resolve(process.cwd(), r))
      .find((f) => existsSync(f))!,
    'utf8',
  );
  it('fetches the order lines and the late-order snapshots', () => {
    expect(src).toContain("'order_snapshot'");
    expect(src).toContain("'late_order_decisions'");
    expect(src).toContain("'item_sku'");
  });
  it('fills Item, Note, Approved by and Date from the helpers', () => {
    expect(src).toContain('get: itemOf');
    expect(src).toContain('noteCell(r');
    expect(src).not.toContain("get: (r) => r.decision_note ?? ''");
    expect(src).not.toContain("get: (r) => r.item_name ?? ''");
    expect(src.match(/isUndecided\(r\) \? pendingLabel/g)?.length).toBe(2);
  });
});
