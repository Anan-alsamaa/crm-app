import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  HTMLAttributes,
  JSX,
  MutableRefObject,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
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

/**
 * Which edges of a horizontal scroller have more content beyond them.
 *
 * Drives the edge fades. Without them a table that continues past the right
 * edge looks exactly like a table that ends there — the columns are simply
 * gone, and the person reading it has no reason to suspect otherwise. That was
 * the actual failure being reported: not that the table could not be scrolled,
 * but that nothing said it could.
 */
function useScrollEdges(): {
  ref: MutableRefObject<HTMLDivElement | null>;
  start: boolean;
  end: boolean;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // scrollLeft goes negative in RTL, so compare magnitudes rather than
      // signs — otherwise every Arabic session shows the fade on the wrong
      // side, or on neither.
      const offset = Math.abs(el.scrollLeft);
      const max = el.scrollWidth - el.clientWidth;
      const next = { start: offset > 1, end: max - offset > 1 };
      setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    // The scroller resizing is one way the answer changes; the TABLE resizing
    // is the other, and it is the common one — toggling a column on makes the
    // content wider without the viewport moving at all.
    //
    // Guarded because these fades are an ENHANCEMENT: they tell you the table
    // continues. Where ResizeObserver is missing — jsdom, and any environment
    // old enough to lack it — the table must still render and still scroll.
    // Unguarded, the constructor threw during commit and React unmounted the
    // whole subtree, so a decoration took every table on the system down with
    // it. Losing a fade is a cosmetic regression; losing the table is not.
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, []);

  return { ref, start: edges.start, end: edges.end };
}

export interface TableSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Cap the table's height so the header stays put while the rows scroll under
   * it. Any CSS length. Off by default: on a short table an inner scrollbar is
   * just a second thing to operate.
   */
  maxHeight?: string;
  /** Accessible name for the scrollable region. */
  scrollLabel?: string;
}

export function TableSurface({
  className,
  children,
  maxHeight,
  scrollLabel,
  ...rest
}: TableSurfaceProps): JSX.Element {
  const { ref, start, end } = useScrollEdges();
  const scrollable = start || end;

  return (
    <div
      className={cn(
        // `overflow-hidden` so the rounded corners actually clip the header
        // band and the last row. Without it the square corners of the content
        // sat proud of the rounded card and the whole thing read as unfinished.
        'relative isolate overflow-hidden rounded-xl bg-card ring-1 ring-foreground/[0.06]',
        className,
      )}
      {...rest}
    >
      <div
        ref={ref}
        // A scrollable region is only a tab stop when there is something to
        // scroll — otherwise every table on the page becomes a stop that does
        // nothing. When it IS scrollable, the arrow keys move it, which is the
        // only way to reach the far columns without a mouse.
        {...(scrollable ? { tabIndex: 0, role: 'region', 'aria-label': scrollLabel } : {})}
        className={cn(
          'overflow-x-auto overscroll-x-contain',
          maxHeight ? 'overflow-y-auto' : '',
          // A visible track. The app's global scrollbar thumb is deliberately
          // faint, which is right for a page and wrong for the one control that
          // reaches half this table's columns.
          '[&::-webkit-scrollbar]:h-3',
          '[&::-webkit-scrollbar-thumb]:rounded-full',
          '[&::-webkit-scrollbar-thumb]:bg-foreground/20',
          'hover:[&::-webkit-scrollbar-thumb]:bg-foreground/30',
          '[&::-webkit-scrollbar-track]:bg-foreground/[0.04]',
          '[scrollbar-width:thin]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50',
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {children}
      </div>

      {/* Edge fades — pointer-events-none so they never swallow a click on the
          cell underneath. Rendered above the content but below the scrollbar. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 start-0 z-[1] w-8 transition-opacity duration-200',
          'bg-gradient-to-r from-card to-transparent rtl:bg-gradient-to-l',
          start ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 end-0 z-[1] w-8 transition-opacity duration-200',
          'bg-gradient-to-l from-card to-transparent rtl:bg-gradient-to-r',
          end ? 'opacity-100' : 'opacity-0',
        )}
      />
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
        // A label row, not a slab. Distinct through weight, spacing and a
        // faint tint — a solid dark band reads as chrome bolted on top of the
        // data rather than as the data's own heading.
        // OPAQUE, not a 70% tint. The header only became genuinely sticky when
        // the report tables gained a maxHeight, and a translucent band with
        // rows sliding under it reads as a rendering fault rather than as a
        // header. Still a faint tint, still a label row — just one you cannot
        // see through.
        'sticky top-0 z-10 h-12 whitespace-nowrap bg-secondary px-4 text-start align-middle',
        // The outermost columns get a wider gutter than the ones between, so
        // the data sits INSIDE the card rather than against its edge. Every
        // table on the system was hugging its own border.
        'first:ps-6 last:pe-6',
        'text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground',
        'backdrop-blur-sm',
        // One hairline under the whole band, rather than a border per cell.
        'shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.08)]',
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
        // No divider. Height, alignment and hover separate the rows; a line
        // under every one of them is what makes a list look like a spreadsheet.
        // Zebra striping is deliberately absent too — it fights the hover.
        'border-0',
        // The hover wash also lifts the row's ink, so a scanned row reads as
        // active rather than merely tinted.
        'group/row transition-colors duration-fast ease-out hover:bg-primary/[0.055] hover:text-foreground',
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
    <td
      className={cn('h-14 px-4 py-3 align-middle text-foreground first:ps-6 last:pe-6', className)}
      {...rest}
    >
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
        'sticky start-0 flex h-12 items-center gap-6 border-t border-foreground/[0.06] bg-secondary/40 px-6 text-xs text-muted-foreground',
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
      className={cn(
        'p-0',
        // The header cell zeroes its own padding here (the button fills the
        // cell), which also cancels the first/last edge gutter. Put it back on
        // the button that is actually doing the filling. cn is a plain join,
        // not tailwind-merge, so leaving both would make the winner depend on
        // stylesheet order rather than on intent.
        '[&:first-child>button]:ps-6 [&:last-child>button]:pe-6',
        className,
      )}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      {...rest}
    >
      <button
        type="button"
        onClick={onSort}
        className={cn(
          'flex h-12 w-full items-center gap-1 px-4 text-2xs font-semibold uppercase tracking-[0.12em] transition-colors duration-fast ease-out',
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
