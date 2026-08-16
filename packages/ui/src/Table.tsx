import { useMemo, useState } from 'react';
import type { HTMLAttributes, JSX, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from './cn.js';

/*
 * Modern data-table primitives, tuned for the dark aurora theme (and still clean
 * on light). A rounded elevated card with clipped corners; a subtly raised
 * header capped by a crisp hairline; roomy rows separated by crisp faint
 * hairlines (light-on-dark, so they read sharp, not streaky); and an
 * accent-tinted hover that gives rows a hint of aurora on interaction. Compose:
 *
 *   <TableSurface>
 *     <Table>
 *       <thead><tr><Th>…</Th></tr></thead>
 *       <tbody><Tr><Td>…</Td></Tr></tbody>
 *     </Table>
 *     <TableFooterBar>…aggregate stats…</TableFooterBar>
 *   </TableSurface>
 */

export function TableSurface({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        // overflow-x-auto, NOT overflow-hidden: a table wider than this surface
        // used to be CLIPPED, so the right-hand columns were unreachable rather
        // than merely cramped. Wide registers (ticket ops, agent reports) now
        // scroll horizontally inside the card instead of losing data.
        'overflow-x-auto rounded-3xl bg-card shadow-[0_1px_2px_oklch(var(--shadow-color)/0.06),0_12px_32px_-12px_oklch(var(--shadow-color)/0.18)]',
        className,
      )}
      {...rest}
    >
      {/* Inner scroller keeps horizontal overflow while the card clips its
          rounded corners cleanly over the raised header. */}
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

export function Table({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableElement>): JSX.Element {
  return (
    <table
      className={cn(
        // `w-full` alone let a many-column table squash every cell to fit.
        // Pairing it with min-w-max keeps the natural column widths once the
        // content needs more room, and the surface above scrolls to reach them.
        'w-full min-w-max border-collapse text-sm',
        className,
      )}
      {...rest}
    >
      {children}
    </table>
  );
}

export function Th({
  className,
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return (
    <th
      className={cn(
        // Ink header band: the table's own masthead.
        'sticky top-0 z-10 h-12 whitespace-nowrap bg-ink px-5 text-start align-middle',
        'text-2xs font-semibold uppercase tracking-[0.12em] text-ink-foreground/75',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Tr({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableRowElement>): JSX.Element {
  return (
    <tr
      className={cn(
        // Crisp faint hairline dividers + an accent-tinted hover wash. Rows
        // marked aria-selected="true" hold a deeper jade wash so a checked
        // selection stays visible without any per-page styling.
        'border-b border-foreground/[0.04] last:border-b-0',
        // The hover wash also lifts the row's ink, so a scanned row reads as
        // active rather than merely tinted.
        'group/row transition-colors duration-fast ease-out hover:bg-primary/[0.06] hover:text-foreground',
        '[&[aria-selected=true]]:bg-primary/10',
        // A jade rail on the selected row — the boards' selection idiom, and
        // logical so it lands on the start edge in RTL too.
        '[&[aria-selected=true]>td:first-child]:relative',
        '[&[aria-selected=true]>td:first-child]:before:absolute',
        '[&[aria-selected=true]>td:first-child]:before:inset-y-0',
        '[&[aria-selected=true]>td:first-child]:before:start-0',
        '[&[aria-selected=true]>td:first-child]:before:w-0.5',
        '[&[aria-selected=true]>td:first-child]:before:bg-primary',
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function Td({
  className,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return (
    <td className={cn('h-14 px-5 align-middle text-foreground', className)} {...rest}>
      {children}
    </td>
  );
}

/**
 * Footer aggregate band — render as a sibling of `<Table>` inside
 * `<TableSurface>`. Children are typically "N rows · aggregate stats".
 */
export function TableFooterBar({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        'flex h-12 items-center gap-6 border-t border-foreground/[0.06] bg-secondary/40 px-5 text-xs text-muted-foreground',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ── Sorting ─────────────────────────────────────────────────────────────── */

export type SortDir = 'asc' | 'desc';

function SortGlyph({ active, dir }: { active: boolean; dir: SortDir }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('h-3 w-3 shrink-0 transition-opacity', active ? 'opacity-100' : 'opacity-30')}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {active ? (
        dir === 'asc' ? (
          <path d="M4 10l4-4 4 4" />
        ) : (
          <path d="M4 6l4 4 4-4" />
        )
      ) : (
        <path d="M5 6.5l3-3 3 3M5 9.5l3 3 3-3" />
      )}
    </svg>
  );
}

/** A clickable, sortable header cell — chevron shows current direction. */
export function SortTh({
  active = false,
  dir = 'asc',
  onSort,
  align = 'start',
  className,
  children,
  ...rest
}: Omit<ThHTMLAttributes<HTMLTableCellElement>, 'onClick' | 'align'> & {
  active?: boolean;
  dir?: SortDir;
  onSort?: () => void;
  align?: 'start' | 'end';
}): JSX.Element {
  return (
    <Th
      className={cn('p-0', className)}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      {...rest}
    >
      <button
        type="button"
        onClick={onSort}
        className={cn(
          'flex h-12 w-full items-center gap-1 px-5 text-2xs font-semibold uppercase tracking-[0.12em] transition-colors duration-fast ease-out',
          align === 'end' ? 'justify-end' : 'justify-start',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {align === 'end' && <SortGlyph active={active} dir={dir} />}
        <span className="truncate">{children}</span>
        {align === 'start' && <SortGlyph active={active} dir={dir} />}
      </button>
    </Th>
  );
}

/**
 * Client-side sort state for a table. Pass the rows and an accessor map keyed by
 * column id (define the map at module scope so its identity is stable). Returns
 * the sorted rows, the active sort, and a `toggle(key)` that cycles asc→desc.
 * Blanks/nulls always sort last.
 */
export function useTableSort<T>(
  rows: T[],
  accessors: Record<string, (row: T) => string | number | null | undefined>,
  initial?: { key: string; dir: SortDir },
): { sorted: T[]; sort: { key: string; dir: SortDir } | null; toggle: (key: string) => void } {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(initial ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const get = accessors[sort.key];
    if (!get) return rows;
    const mult = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const na = va == null || va === '';
      const nb = vb == null || vb === '';
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
      return String(va).localeCompare(String(vb)) * mult;
    });
    // `accessors` is expected to be a stable module-scope reference.
  }, [rows, sort, accessors]);
  const toggle = (key: string) =>
    setSort((s) =>
      s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  return { sorted, sort, toggle };
}
