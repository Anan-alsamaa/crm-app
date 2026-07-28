import type { JSX } from 'react';
import { cn } from './cn.js';

/*
 * Compact, windowed pager: « Previous · 1 2 3 … 9 10 · Next ». Renders nothing
 * for a single page. Purely presentational — the caller owns page state and
 * slices its own rows.
 */

export interface PaginationProps {
  /** 1-based current page. */
  page: number;
  /** Total number of pages. */
  pageCount: number;
  onPage: (page: number) => void;
  prevLabel?: string;
  nextLabel?: string;
  className?: string;
}

/** Page numbers to show, collapsing the middle with ellipses for long ranges. */
function windowed(page: number, count: number): (number | 'gap')[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const out: (number | 'gap')[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(count - 1, page + 1);
  if (start > 2) out.push('gap');
  for (let i = start; i <= end; i++) out.push(i);
  if (end < count - 1) out.push('gap');
  out.push(count);
  return out;
}

const edgeBtn =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground ring-1 ring-border transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

export function Pagination({
  page,
  pageCount,
  onPage,
  prevLabel = 'Previous',
  nextLabel = 'Next',
  className,
}: PaginationProps): JSX.Element | null {
  if (pageCount <= 1) return null;
  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className={edgeBtn}
      >
        <span aria-hidden>‹</span>
        <span className="hidden sm:inline">{prevLabel}</span>
      </button>

      <div className="flex items-center gap-1">
        {windowed(page, pageCount).map((it, i) =>
          it === 'gap' ? (
            <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground">
              …
            </span>
          ) : (
            <button
              key={it}
              type="button"
              onClick={() => onPage(it)}
              aria-current={it === page ? 'page' : undefined}
              className={cn(
                'grid h-8 min-w-[2rem] place-items-center rounded-lg px-2 text-xs font-semibold tabular-nums transition-colors duration-fast ease-out',
                it === page
                  ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/30'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              {it}
            </button>
          ),
        )}
      </div>

      <button
        type="button"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
        className={edgeBtn}
      >
        <span className="hidden sm:inline">{nextLabel}</span>
        <span aria-hidden>›</span>
      </button>
    </div>
  );
}
