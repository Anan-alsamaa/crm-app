import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE BOARD'S COLUMNS (owner, 2026-10-25): exactly these, in this order, each
 * reusing the table's own value. Asserted against the source - the page needs
 * a QueryClient, Directus, the commerce gateway and auth to mount.
 */
const SRC = readFileSync(
  resolve(import.meta.dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
  'utf8',
);
const BOARD = readFileSync(
  resolve(import.meta.dirname, '../src/features/late-orders/board.tsx'),
  'utf8',
);

const header = SRC.slice(SRC.indexOf("['lateOrders.col.elapsed', 'Total time']"));
const row = SRC.slice(SRC.indexOf('const boardRow = '), SRC.indexOf('const activeFilterCount'));

describe('the late-orders board', () => {
  /* The owner's eleven, plus the order number after Total time (2026-10-25). */
  it("heads the owner's columns, in his order", () => {
    const labels = [
      ...header.slice(0, header.indexOf('] as const')).matchAll(/\['[^']+', '([^']+)'\]/g),
    ].map((m) => m[1]);
    expect(labels).toEqual([
      'Total time',
      'Order',
      'Service time',
      'Driver arrival',
      'Delivery time',
      'Preparation time',
      'Brand',
      'Restaurant',
      'Customer mobile',
      'Order status',
      'Status',
      'Source of delay',
    ]);
  });

  it("fills the cells in the same order, from the table's own values", () => {
    const order = [
      '<LateBy minutes={row.minutesElapsed}',
      'tabular-nums text-foreground 2xl:text-xl"',
      'boardLeg(times.serviceMinutes',
      'boardLeg(times.driverArrivalMinutes)',
      'boardLeg(times.deliveryMinutes)',
      'boardLeg(times.preparationMinutes)',
      '{row.brandName ||',
      '{row.restaurantName ||',
      '{customer}',
      'commerce.orderStatuses.',
      'stateTone[state].label',
      'value={kindOf(row)}',
    ].map((needle) => row.indexOf(needle));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps the row actions, compact at the row end', () => {
    const actions = row.slice(row.indexOf('value={kindOf(row)}'));
    expect(actions).toMatch(/setExpanded\(row\.orderId\)/);
    expect(actions).toMatch(/openDecision\(row, 'commented', true\)/);
    expect(actions).toMatch(/openDecision\(row, 'compensated'\)/);
  });
});

describe('the Total time chip', () => {
  /* Owner, 2026-10-25: no "Critical", then no "Late" / "Very late" either.
     The colour scale stays; the word is for screen readers only. */
  it('shows no visible lateness word at any step, only a screen-reader one', () => {
    expect(BOARD).toMatch(/const wordEl = <span className="sr-only">\{word\}<\/span>;/);
    expect(BOARD).not.toMatch(/text-xs font-semibold text-foreground\/70[^"]*">\{word\}/);
    expect(BOARD).toMatch(/critical: 'bg-destructive text-destructive-foreground'/);
  });
});
