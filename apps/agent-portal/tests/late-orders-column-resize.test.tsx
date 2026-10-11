import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useColumnResize } from '../src/features/late-orders/useColumnResize.js';
import {
  LATE_ORDER_COLUMN_WIDTHS_KEY,
  MIN_COLUMN_WIDTH,
  loadLateOrderColumnWidths,
} from '../src/features/late-orders/columns.js';

/**
 * Excel-style column resizing on Late orders (owner, 2026-10-11): drag a
 * header's edge and the column - header and values - takes that width.
 */
function thead(widths: number[]) {
  const t = document.createElement('table');
  const head = t.createTHead();
  const row = head.insertRow();
  for (const w of widths) {
    const th = document.createElement('th');
    th.getBoundingClientRect = () => ({ width: w }) as DOMRect;
    row.appendChild(th);
  }
  return { current: head };
}
const pointer = (x: number) =>
  ({
    clientX: x,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    currentTarget: document.body,
  }) as unknown as React.PointerEvent<HTMLElement>;

beforeEach(() => window.localStorage.clear());

describe('Late orders column resize', () => {
  it('measures the natural widths, then widens the dragged column and saves it', () => {
    const { result } = renderHook(() => useColumnResize(['order', 'brand'], thead([100, 150])));
    expect(result.current.widths).toBeNull();
    act(() => result.current.start('order', pointer(200)));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 260 }) as PointerEvent);
      window.dispatchEvent(new MouseEvent('pointerup') as PointerEvent);
    });
    expect(result.current.widths).toMatchObject({ order: 160, brand: 150 });
    expect(loadLateOrderColumnWidths()).toMatchObject({ order: 160, brand: 150 });
  });

  it('can narrow a column below its content, but never below the minimum', () => {
    const { result } = renderHook(() => useColumnResize(['order'], thead([100])));
    act(() => result.current.start('order', pointer(200)));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0 }) as PointerEvent);
      window.dispatchEvent(new MouseEvent('pointerup') as PointerEvent);
    });
    expect(result.current.widths?.order).toBe(MIN_COLUMN_WIDTH);
  });

  it('double-click resets to the natural widths', () => {
    window.localStorage.setItem(LATE_ORDER_COLUMN_WIDTHS_KEY, JSON.stringify({ order: 300 }));
    const { result } = renderHook(() => useColumnResize(['order'], thead([100])));
    expect(result.current.widths).toMatchObject({ order: 300 });
    act(() => result.current.reset());
    expect(result.current.widths).toBeNull();
    expect(window.localStorage.getItem(LATE_ORDER_COLUMN_WIDTHS_KEY)).toBeNull();
  });

  it('the table uses the widths for header AND values (colgroup, fixed layout)', () => {
    const page = readFileSync(
      resolve(__dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
      'utf8',
    );
    expect(page).toMatch(/<colgroup>/);
    expect(page).toMatch(/tableLayout: 'fixed'/);
    expect(page).toMatch(/onPointerDown=\{\(e\) => resize\.start\(k, e\)\}/);
  });
});
