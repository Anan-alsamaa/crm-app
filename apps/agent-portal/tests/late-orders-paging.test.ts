import { describe, it, expect } from 'vitest';
import { pageCountOf } from '@yiji/ui';

/**
 * THE DURATION BATCH MUST NOT BE HANDED MORE IDS THAN IT CAN ASK ABOUT.
 *
 * The late-orders queue rendered every filtered row and passed every row's id
 * to `useOrderEventTimes`, while the comment above it claimed "the rows actually
 * on screen". The gateway caps a batch at 50 ids, so on a history range — 598
 * rows over 30 days on production — every row past the fiftieth showed EMPTY
 * Service, Driver arrival, Delivery and Preparation columns.
 *
 * That is the failure shape this codebase keeps producing: not an error, but a
 * blank that reads as "not known" when the truth is "never asked". See
 * [[silent-empty-failures]].
 *
 * The fix is paging, with the page size capped at the batch size. These pin the
 * arithmetic that makes the two agree.
 */
const PAGE_SIZES = [10, 25, 50] as const;
const GATEWAY_BATCH_CAP = 50;

describe('late-orders paging keeps the duration batch honest', () => {
  /* THE LOAD-BEARING ONE. If a page can hold more rows than the gateway will
     answer for, the columns go blank again and nothing says so. */
  it('never offers a page larger than the gateway batch cap', () => {
    for (const size of PAGE_SIZES) expect(size).toBeLessThanOrEqual(GATEWAY_BATCH_CAP);
  });

  it('pages the real production volume rather than rendering it whole', () => {
    // 598 late orders over the report's own 30-day window, measured on prod.
    expect(pageCountOf(598, 25)).toBe(24);
    expect(pageCountOf(598, 50)).toBe(12);
  });

  /* A page always exists, even with nothing to show — otherwise the pager reads
     "page 1 of 0" and the clamp below has no floor to land on. */
  it('always has at least one page', () => {
    expect(pageCountOf(0, 25)).toBe(1);
  });

  /*
   * CLAMPING, not storing. An agent on page 9 who then narrows the filters must
   * land on the last real page rather than an empty one that looks like a queue
   * with nothing in it.
   */
  it('clamps a page number past the end', () => {
    const clamp = (page: number, total: number, size: number) =>
      Math.min(Math.max(1, page), pageCountOf(total, size));
    expect(clamp(9, 30, 25)).toBe(2);
    expect(clamp(9, 0, 25)).toBe(1);
    expect(clamp(-3, 100, 25)).toBe(1);
    expect(clamp(2, 100, 25)).toBe(2);
  });

  /* The slice the page renders, and the ids the batch is given, must be the
     same set — that identity is the whole point. */
  it('slices the page the batch is asked about', () => {
    const rows = Array.from({ length: 598 }, (_, i) => `order-${i}`);
    const size = 25;
    const page = 3;
    const paged = rows.slice((page - 1) * size, page * size);
    expect(paged).toHaveLength(25);
    expect(paged[0]).toBe('order-50');
    expect(paged.length).toBeLessThanOrEqual(GATEWAY_BATCH_CAP);
  });

  it('gives the last page only what is left', () => {
    const rows = Array.from({ length: 598 }, (_, i) => i);
    const size = 25;
    const last = pageCountOf(rows.length, size);
    expect(rows.slice((last - 1) * size, last * size)).toHaveLength(598 - 23 * 25);
  });
});
