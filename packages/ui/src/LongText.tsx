import type { JSX } from 'react';
import { cn } from './cn.js';

/**
 * A truncated cell that shows the WHOLE value on hover or focus.
 *
 * Asked for by operations against the late-orders Reason and Action columns
 * (2026-10-04): *"On hover, the Reason and Action should display the full
 * data."* Both already carried a `title`, and that was the problem — a native
 * tooltip is:
 *
 *   - invisible on a touch screen, which is how half the floor reads these,
 *   - invisible to a keyboard user, who never generates a hover at all,
 *   - slow enough that an agent scanning a column gives up before it appears,
 *   - unable to wrap: a two-line reason renders as one clipped strip.
 *
 * The same objection the quick-replies panel answered by showing the text
 * rather than hiding it behind `title`.
 *
 * So: a panel, on hover AND on focus-within, with `title` kept as the
 * plain-text fallback for anything that reads the DOM rather than renders it
 * (and for a browser-native tooltip while the pointer is still travelling).
 *
 * CSS-only, deliberately. A column of these is one per row per column, and
 * hover state in React means a re-render per mouse move across a table that
 * already fetches order timings per page. `group-hover` costs nothing.
 */
export interface LongTextProps {
  /** The full value. Null, undefined and blank all render as the dash. */
  value?: string | null;
  /** What to show when there is nothing. */
  empty?: string;
  /** Extra classes for the collapsed line. */
  className?: string;
}

export function LongText({ value, empty = '-', className }: LongTextProps): JSX.Element {
  const text = value?.trim() ?? '';
  /* NOTHING TO EXPAND. A dash must not sprout a panel — and must not be
     focusable, or tabbing through a report stops on every blank cell. */
  if (!text) return <span className="text-muted-foreground">{empty}</span>;

  return (
    <span className="group/longtext relative inline-block max-w-full align-top">
      {/*
       * FOCUSABLE, so the keyboard reaches it. `tabIndex={0}` on a span is
       * right here: it is not a control, it performs no action, and making it a
       * button would announce it as one to a screen reader and put a press
       * target in every cell of a report.
       */}
      <span
        tabIndex={0}
        title={text}
        className={cn(
          'block truncate rounded outline-none',
          /* A HINT THAT THERE IS MORE, rather than a hard edge. The underline
             appears on hover, so a column of these reads as text until you
             reach for one — a permanent affordance on every cell would make a
             report look like a wall of links. */
          'decoration-border decoration-dotted underline-offset-[3px]',
          'transition-colors duration-fast group-hover/longtext:underline',
          'focus-visible:ring-2 focus-visible:ring-ring/50',
          className,
        )}
      >
        {text}
      </span>
      {/*
       * THE PANEL — and you can put the cursor IN it and select the text.
       *
       * Redesigned twice. The first cut was "boxy" (owner, 2026-10-04): a hard
       * border, square corners and a flat fill, reading as a dialog bolted onto
       * a table cell rather than the value expanding. The second was worse in
       * the way that matters: *"when trying to place cursor to the complete
       * value it stops being displayed"* — the whole point of showing the full
       * text is to be able to COPY it, and it was unreachable.
       *
       * Two things made it unreachable, and both had to go:
       *
       *  1. `pointer-events-none`. It was there so the panel could never
       *     swallow a click meant for the row beneath — but it also means the
       *     cursor passes straight through, so the panel never counts as
       *     hovered and the moment the pointer leaves the CELL it closes. A
       *     panel you cannot point at is a panel you cannot select text in.
       *     The hover now lives on the wrapper, which contains both, so moving
       *     into the panel keeps it open.
       *
       *  2. THE GAP. A visible margin between the cell and the panel is dead
       *     space: the pointer crosses it, is over neither, and the panel
       *     closes mid-journey. The margin is replaced by transparent top
       *     padding INSIDE the panel, so the gap is part of the hover target
       *     and the crossing is unbroken. `pt-1.5` + `-mt-0` rather than
       *     `mt-1.5`.
       *
       * `select-text` and `cursor-text` say it is selectable; `z-20` keeps it
       * over the following rows rather than clipped by them.
       */}
      <span
        role="tooltip"
        className={cn(
          'absolute start-0 top-full z-20 w-max max-w-sm pt-1.5',
          'invisible -translate-y-1 opacity-0',
          'transition-[opacity,transform,visibility] duration-base ease-out',
          'group-hover/longtext:visible group-hover/longtext:translate-y-0 group-hover/longtext:opacity-100',
          'group-focus-within/longtext:visible group-focus-within/longtext:translate-y-0 group-focus-within/longtext:opacity-100',
        )}
      >
        <span
          className={cn(
            'block cursor-text select-text whitespace-pre-wrap break-words',
            'rounded-xl bg-popover px-3.5 py-2.5',
            'text-start text-xs font-normal normal-case leading-relaxed text-foreground',
            'shadow-float ring-1 ring-border/60',
          )}
        >
          {text}
        </span>
      </span>
    </span>
  );
}
