import type { JSX } from 'react';
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
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        // `sticky start-0` pins it against a horizontal page scroll — see
        // ReportKpiStrip. `w-fit` so sticking does not stretch the pill row.
        'sticky start-0 inline-flex w-fit shrink-0 items-center gap-1 rounded-full bg-secondary p-1',
        className,
      )}
    >
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
              'rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors duration-fast ease-out',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              active
                ? 'bg-card text-foreground shadow-soft'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
            {typeof o.count === 'number' && (
              <span className="ms-1.5 tabular-nums font-normal opacity-60">{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
