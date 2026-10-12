import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { headerWithHandle } from '../src/features/late-orders/header-cell.js';

/**
 * 2026-10-12: the Late orders headers slid right of their values. A header
 * written as `<>{comment}<th/></>` got its resize handle BESIDE the cell, and
 * the browser drew that as an extra blank column.
 */
function row(...cells: React.ReactNode[]) {
  const { container } = render(
    <table>
      <thead>
        <tr>
          {cells.map((c, i) => (
            <React.Fragment key={i}>{headerWithHandle(c, <span data-handle="" />)}</React.Fragment>
          ))}
        </tr>
      </thead>
    </table>,
  );
  return container.querySelector('tr')!;
}

describe('headerWithHandle', () => {
  it('puts the handle INSIDE a header written as a fragment', () => {
    const tr = row(
      <>
        {/* a comment */}
        <th className="x">Creation time</th>
      </>,
      <th>Business day</th>,
    );
    // Exactly one child per column, every one a <th>, each holding its handle.
    expect([...tr.children].map((c) => c.tagName)).toEqual(['TH', 'TH']);
    expect(tr.querySelectorAll('th > [data-handle]')).toHaveLength(2);
    expect(tr.children[0]!.className).toContain('relative');
    expect(tr.children[0]!.className).toContain('x');
  });

  it('never adds a node to the row when the header is not a single cell', () => {
    const tr = row(
      <>
        <th>A</th>
        <th>B</th>
      </>,
    );
    expect([...tr.children].map((c) => c.tagName)).toEqual(['TH', 'TH']);
    expect(tr.querySelectorAll('[data-handle]')).toHaveLength(0);
  });
});
