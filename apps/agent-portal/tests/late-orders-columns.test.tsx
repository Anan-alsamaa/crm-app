import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LATE_ORDER_COLUMN_KEYS,
  LATE_ORDER_COLUMN_LABELS,
  LATE_ORDER_COLUMNS_HIDDEN_KEY,
  LATE_ORDER_COLUMNS_ORDER_KEY,
  loadLateOrderColumnOrder,
  loadLateOrderHiddenColumns,
  toggleHiddenColumn,
  visibleLateOrderColumns,
  type LateOrderColumnKey,
} from '../src/features/late-orders/columns.js';
import { LateOrderColumnsPicker } from '../src/features/late-orders/LateOrderColumnsPicker.js';

/*
 * CHOOSE AND ARRANGE THE LATE-ORDERS COLUMNS (owner, 2026-10-11): "like what
 * we implemented in the tickets breakdown page in the admin portal".
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = (o?.defaultValue ?? k) as string;
      if (o) {
        for (const [key, val] of Object.entries(o)) {
          if (key === 'defaultValue') continue;
          s = s.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(val));
        }
      }
      return s;
    },
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));

const PAGE = readFileSync(
  resolve(import.meta.dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
  'utf8',
);

const ALL: LateOrderColumnKey[] = [
  'created',
  'businessDay',
  'order',
  'elapsed',
  'service',
  'driverArrival',
  'delivery',
  'preparation',
  'brand',
  'restaurant',
  'customer',
  'status',
  'kind',
  'agent',
  'reason',
  'actionTaken',
  'detail',
  'actions',
  'comments',
];

const labelOf = (k: LateOrderColumnKey) => LATE_ORDER_COLUMN_LABELS[k].def;

/** The page's header row in miniature: the picker plus a header rendered from
    the same state, exactly as the page renders `columnDefs[k].th`. */
function Harness() {
  const [order, setOrder] = useState(() => loadLateOrderColumnOrder());
  const [hidden, setHidden] = useState(() => loadLateOrderHiddenColumns());
  return (
    <>
      <LateOrderColumnsPicker
        order={order}
        hidden={hidden}
        onOrder={setOrder}
        onHidden={setHidden}
        labelOf={labelOf}
      />
      <table>
        <thead>
          <tr data-testid="head">
            {visibleLateOrderColumns(order, hidden).map((k) => (
              <th key={k} data-key={k}>
                {labelOf(k)}
              </th>
            ))}
          </tr>
        </thead>
      </table>
    </>
  );
}

const headKeys = () =>
  Array.from(screen.getByTestId('head').querySelectorAll('th')).map((th) =>
    th.getAttribute('data-key'),
  );

const openPicker = () => fireEvent.click(screen.getByRole('button', { name: /^Columns/ }));
const pickerRow = (k: LateOrderColumnKey) =>
  document.querySelector(`li[data-column="${k}"]`) as HTMLElement;

beforeEach(() => localStorage.clear());

describe('the column list', () => {
  it('includes every column, in the table’s original order', () => {
    expect([...LATE_ORDER_COLUMN_KEYS]).toEqual(ALL);
    expect(Object.keys(LATE_ORDER_COLUMN_LABELS).sort()).toEqual([...ALL].sort());
  });

  it('gives every key a header and a cell in the page', () => {
    for (const k of ALL) expect(PAGE).toMatch(new RegExp(`\\n    ${k}: \\{\\n      th:`));
    // The header is the column's own <Th>, cloned to carry the resize handle.
    expect(PAGE).toMatch(/headerWithHandle\(\s*columnDefs\[k\]\.th,/);
    expect(PAGE).toMatch(/<Fragment key=\{k\}>\{columnDefs\[k\]\.td\(row\)\}<\/Fragment>/);
  });

  it('defaults to every column shown when nothing is saved', () => {
    render(<Harness />);
    expect(headKeys()).toEqual(ALL);
    expect(screen.getByRole('button', { name: /^Columns/ })).toHaveTextContent('19/19');
  });
});

describe('showing and hiding', () => {
  it('hiding a column removes its header and is remembered', () => {
    render(<Harness />);
    openPicker();
    fireEvent.click(within(pickerRow('agent')).getByRole('checkbox'));
    expect(headKeys()).not.toContain('agent');
    expect(JSON.parse(localStorage.getItem(LATE_ORDER_COLUMNS_HIDDEN_KEY) ?? '[]')).toEqual([
      'agent',
    ]);
    expect(loadLateOrderHiddenColumns().has('agent')).toBe(true);
  });

  it('never hides the last visible column', () => {
    const allButOne = new Set<LateOrderColumnKey>(ALL.filter((k) => k !== 'order'));
    expect(toggleHiddenColumn(allButOne, 'order')).toEqual(allButOne);
    /* A stored value that hides everything is ignored, not obeyed. */
    localStorage.setItem(LATE_ORDER_COLUMNS_HIDDEN_KEY, JSON.stringify(ALL));
    expect(loadLateOrderHiddenColumns().size).toBe(0);
  });

  it('"All" shows everything again', () => {
    localStorage.setItem(LATE_ORDER_COLUMNS_HIDDEN_KEY, JSON.stringify(['agent', 'reason']));
    render(<Harness />);
    expect(headKeys()).not.toContain('reason');
    openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(headKeys()).toEqual(ALL);
  });
});

describe('reordering', () => {
  it('persists a move to localStorage and restores it on the next visit', () => {
    const first = render(<Harness />);
    openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Move Agent earlier' }));
    const moved = JSON.parse(localStorage.getItem(LATE_ORDER_COLUMNS_ORDER_KEY) ?? '[]');
    expect(moved.indexOf('agent')).toBe(ALL.indexOf('agent') - 1);
    first.unmount();

    render(<Harness />);
    expect(headKeys()).toEqual(moved);
  });

  it('drag and drop moves a column', () => {
    render(<Harness />);
    openPicker();
    const dt = { effectAllowed: '', setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(pickerRow('comments'), { dataTransfer: dt });
    fireEvent.dragOver(pickerRow('created'), { dataTransfer: dt });
    fireEvent.drop(pickerRow('created'), { dataTransfer: dt });
    expect(headKeys()[0]).toBe('comments');
  });

  it('Reset order goes back to the default order', () => {
    localStorage.setItem(LATE_ORDER_COLUMNS_ORDER_KEY, JSON.stringify([...ALL].reverse()));
    render(<Harness />);
    expect(headKeys()[0]).toBe('comments');
    openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Reset order' }));
    expect(headKeys()).toEqual(ALL);
  });
});

describe('reconciling a saved arrangement', () => {
  it('keeps a column added since, and drops one that no longer exists', () => {
    /* Saved before `comments` existed, and carrying a retired key. */
    const saved = [
      'order',
      'created',
      'retired',
      ...ALL.filter((k) => k !== 'order' && k !== 'created' && k !== 'comments'),
    ];
    localStorage.setItem(LATE_ORDER_COLUMNS_ORDER_KEY, JSON.stringify(saved));
    const order = loadLateOrderColumnOrder();
    expect(order).not.toContain('retired');
    expect(order).toContain('comments');
    expect(order.slice(0, 2)).toEqual(['order', 'created']);
    expect(order).toHaveLength(ALL.length);
  });

  it('survives unreadable storage', () => {
    localStorage.setItem(LATE_ORDER_COLUMNS_ORDER_KEY, '{not json');
    localStorage.setItem(LATE_ORDER_COLUMNS_HIDDEN_KEY, '{not json');
    expect(loadLateOrderColumnOrder()).toEqual(ALL);
    expect(loadLateOrderHiddenColumns().size).toBe(0);
  });
});
