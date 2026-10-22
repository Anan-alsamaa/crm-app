import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { cn } from '@yiji/ui';

/**
 * Two or three views of the same data, one on screen at a time.
 *
 * Written for the report that had two tables stacked on one page. Both were
 * worth having — one answers "which chats", the other "how many, on which
 * days" — but stacked they each asked for the height left below them, so on a
 * laptop the pair resolved to two three-row boxes with the second below the
 * fold, and the single Export button between them wrote only the first with
 * nothing on screen saying so.
 *
 * A switch is the honest shape: one table, the whole height, and the actions
 * beside it belong to what you can see.
 *
 * `role="tablist"` rather than a row of buttons — a reader on a keyboard gets
 * arrow-key movement and a screen reader is told this is one choice among
 * several, not several unrelated commands.
 */
export interface ViewSwitchOption<T extends string> {
  value: T;
  label: string;
  /** Rendered after the label as a muted count, when there is one worth saying. */
  count?: number;
}

export function ViewSwitch<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<ViewSwitchOption<T>>;
  /** Accessible name for the group, e.g. "Chat status views". */
  label: string;
  className?: string;
}): JSX.Element {
  /*
   * A segmented control (owner, 2026-10-22): one raised white segment that
   * SLIDES to the chosen view. The segment is a single element moved with
   * `transform` - measured from the chosen button, never animated in width
   * by layout - so a switch costs one composited move. Until it has been
   * measured (first paint, or a test DOM with no layout) the chosen button
   * paints its own background, so the selection is never invisible.
   */
  const listRef = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number; ready: boolean } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const btn = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!btn || btn.offsetWidth === 0) return;
      setThumb((prev) => {
        const next = { x: btn.offsetLeft, w: btn.offsetWidth, ready: prev !== null };
        return prev && prev.x === next.x && prev.w === next.w ? prev : next;
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [value, options]);

  const placed = thumb !== null;
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      className={cn(
        // `sticky start-0` pins it against a horizontal page scroll — see
        // ReportKpiStrip. `w-fit` so sticking does not stretch the pill row.
        'sticky start-0 isolate inline-flex w-fit shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] p-1',
        className,
      )}
    >
      {placed && (
        <span
          aria-hidden
          className={cn(
            'absolute inset-y-1 left-0 -z-10 rounded-full bg-glass shadow-[0_4px_14px_-6px_oklch(var(--shadow-color)/0.45)]',
            thumb.ready &&
              'transition-transform duration-[260ms] ease-out motion-reduce:transition-none',
          )}
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
        />
      )}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            // Only the selected tab is in the tab order; the arrow keys move
            // between them. A tablist that costs one tab stop per option is a
            // tablist keyboard users route around.
            tabIndex={active ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const i = options.findIndex((x) => x.value === value);
              const step = e.key === 'ArrowRight' ? 1 : -1;
              const next = options[(i + step + options.length) % options.length];
              if (next) onChange(next.value);
            }}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-9 items-center rounded-full px-4 text-sm font-semibold transition-colors duration-fast ease-out',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              active &&
                !placed &&
                'bg-glass shadow-[0_4px_14px_-6px_oklch(var(--shadow-color)/0.45)]',
            )}
          >
            {o.label}
            {typeof o.count === 'number' && (
              <span
                className={cn(
                  'ms-2 inline-grid h-5 min-w-[1.25rem] place-items-center rounded-full px-1.5 text-2xs font-semibold tabular-nums',
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'bg-foreground/[0.07] text-muted-foreground',
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
