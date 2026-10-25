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
      'tabular-nums text-foreground 2xl:text-lg"',
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

describe('brand and restaurant are read in full (owner, 2026-10-25)', () => {
  it('wrap on the board instead of truncating', () => {
    expect(SRC).toMatch(/const boardName =\s+'block whitespace-normal break-words /);
    const names = row.slice(
      row.indexOf('{row.brandName ||') - 200,
      row.indexOf("cn(boardText, 'tabular-nums')"),
    );
    expect(names).toMatch(/className=\{cn\(boardName, 'font-semibold'\)\}/);
    expect(names).toMatch(/className=\{boardName\}/);
    expect(names).not.toMatch(/boardText/);
    expect(names).not.toMatch(/truncate/);
  });

  it('get a guaranteed width on the board at both TV sizes', () => {
    expect(SRC).toMatch(/grid-cols-\[[^\]]*_minmax\(8rem,1\.25fr\)_minmax\(9rem,1\.45fr\)_/);
    expect(SRC).toMatch(/2xl:grid-cols-\[[^\]]*_minmax\(10rem,1\.25fr\)_minmax\(11rem,1\.45fr\)_/);
  });

  it('wrap in the table view too', () => {
    const brand = SRC.slice(SRC.indexOf('    brand: {'), SRC.indexOf('    customer: {'));
    expect(brand).not.toMatch(/truncate/);
    expect(brand.match(/whitespace-normal break-words/g)?.length).toBe(2);
  });
});

describe('the board type is one step smaller (owner, 2026-10-25)', () => {
  it('legs, row text and headers step down', () => {
    expect(SRC).toMatch(/whitespace-nowrap text-sm font-semibold tabular-nums 2xl:text-lg/);
    expect(SRC).toMatch(
      /const boardText = 'block truncate text-sm text-foreground 2xl:text-base';/,
    );
    expect(SRC).toMatch(/text-2xs font-semibold text-muted-foreground 2xl:min-h-12 2xl:text-xs/);
  });

  it('Total time stays the largest figure, one step down too', () => {
    expect(BOARD).toMatch(/'text-\[1\.375rem\] 2xl:px-3\.5 2xl:text-\[1\.875rem\]'/);
  });
});
