import type { JSX } from 'react';
import { cn } from './cn.js';
import { Pagination } from './Pagination.js';
import { SelectMenu } from './SelectMenu.js';

/*
 * The bar that sits under every report table: what you are looking at, how much
 * of it to show at once, and which page you are on.
 *
 * It exists because those three controls were previously either absent or
 * assembled by hand per page, so each report answered "how do I get to row 300"
 * differently — and three of the five did not answer it at all. One component
 * means one answer, and a report that gains rows cannot quietly become a
 * thousand-row scroll.
 *
 * Responsive by construction: the range readout and the size picker sit on one
 * line with the pager pushed to the end on a desktop, and stack into two rows
 * on a phone, where the pager also drops its numeric strip for a "3 / 12"
 * readout that fits a thumb.
 */

export interface TablePagerLabels {
  /** "Rows per page" */
  rowsPerPage?: string;
  /** Receives from/to/total — e.g. "Showing 26–50 of 240". */
  showing?: (range: { from: number; to: number; total: number }) => string;
  previous?: string;
  next?: string;
}

export interface TablePagerProps {
  /** 1-based current page. */
  page: number;
  onPage: (page: number) => void;
  pageSize: number;
  onPageSize: (size: number) => void;
  /** Rows available AFTER filtering — what the range and page count describe. */
  total: number;
  pageSizes?: readonly number[];
  labels?: TablePagerLabels;
  className?: string;
}

export const DEFAULT_PAGE_SIZES = [10, 25, 50, 100, 200] as const;

/** Page count for a total and a size — never less than one, so page 1 exists. */
export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function TablePager({
  page,
  onPage,
  pageSize,
  onPageSize,
  total,
  pageSizes = DEFAULT_PAGE_SIZES,
  labels,
  className,
}: TablePagerProps): JSX.Element {
  const pageCount = pageCountOf(total, pageSize);
  // Clamped rather than stored: filtering down while sitting on page 9 must not
  // strand the reader on a page that no longer exists.
  const current = Math.min(Math.max(1, page), pageCount);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);

  const rowsPerPage = labels?.rowsPerPage ?? 'Rows per page';
  const showing = labels?.showing?.({ from, to, total }) ?? `Showing ${from}–${to} of ${total}`;

  return (
    /* `sticky start-0` pins it against a horizontal page scroll — see
       ReportKpiStrip for why. A pager that slides out of the window when you
       scroll to the far columns is a pager you have to scroll back for. */
    <div
      className={cn(
        'sticky start-0 flex w-[var(--pin-w,100%)] flex-col gap-3 sm:flex-row sm:items-center sm:gap-4',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="whitespace-nowrap">{rowsPerPage}</span>
          <SelectMenu
            size="sm"
            className="w-[5.5rem]"
            aria-label={rowsPerPage}
            value={String(pageSize)}
            onChange={(v) => {
              onPageSize(Number(v));
              // Row 300 is on a different page at 25 than at 100, so the page
              // number cannot survive the change. Returning to the start is
              // the only honest answer.
              onPage(1);
            }}
            options={pageSizes.map((n) => ({ value: String(n), label: String(n) }))}
          />
        </label>
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {showing}
        </span>
      </div>

      <div className="sm:ms-auto">
        <Pagination
          page={current}
          pageCount={pageCount}
          onPage={onPage}
          prevLabel={labels?.previous ?? 'Previous'}
          nextLabel={labels?.next ?? 'Next'}
        />
      </div>
    </div>
  );
}
