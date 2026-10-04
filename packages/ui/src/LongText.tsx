import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';

/**
 * A truncated cell that shows the WHOLE value, and lets you SELECT and COPY it.
 *
 * Asked for against the late-orders Reason and Action columns (ops,
 * 2026-10-04), then corrected twice — and the second correction is the reason
 * this file looks the way it does.
 *
 *   1. *"needs a modern design, looks boxy"* — a hard border and a flat fill
 *      read as a dialog bolted onto a table cell rather than the value
 *      expanding.
 *   2. *"when trying to place cursor to the complete value it stops being
 *      displayed"* — twice. The whole point of showing the full text is to be
 *      able to copy it, and it was unreachable.
 *
 * ## Why an absolutely-positioned panel could never work here
 *
 * These cells live inside `TableSurface`, and its own comment spells out the
 * trap: **CSS turns `overflow-y: visible` into `auto` the moment `overflow-x`
 * is `auto`**, so a horizontally scrolling table is a VERTICAL scroll container
 * too, whether or not anybody asked. An `absolute` panel is laid out inside
 * that box and is therefore CLIPPED by it — reaching for the panel scrolls the
 * table or hides it.
 *
 * No amount of `z-index` escapes an ancestor's overflow. So the panel is
 * PORTALLED to `document.body` and positioned from the cell's measured rect.
 *
 * ## And it is driven by explicit open/close, not `:hover`
 *
 * A CSS `group-hover` cannot span a portal — the panel is no longer a DOM
 * descendant of the cell, so moving into it ends the hover and closes it. The
 * open state is therefore real state, held open while the pointer is over
 * EITHER the cell or the panel, with a short grace period for the gap between
 * them.
 *
 * `title` is gone too: a native tooltip renders over the panel and covers the
 * very text you are trying to select.
 */
export interface LongTextProps {
  /** The full value. Null, undefined and blank all render as the dash. */
  value?: string | null;
  /** What to show when there is nothing. */
  empty?: string;
  /** Extra classes for the collapsed line. */
  className?: string;
}

/** How long the panel survives the pointer leaving, so the gap is crossable. */
const GRACE_MS = 120;

export function LongText({ value, empty = '-', className }: LongTextProps): JSX.Element {
  const text = value?.trim() ?? '';
  const cellRef = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  /* Cleared on open, set on leave — so re-entering the panel cancels the close
     that the cell's own `mouseleave` just scheduled. */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const el = cellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    /* Viewport coordinates + `position: fixed`, so the panel needs no scroll
       maths and cannot drift when an ancestor scrolls — it is simply closed on
       scroll instead, below. */
    setRect({ top: r.bottom, left: r.left, width: r.width });
  }, []);

  const close = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setRect(null), GRACE_MS);
  }, []);

  /*
   * CLOSE ON SCROLL, RESIZE AND ESCAPE.
   *
   * The panel is positioned from a rect measured once. Anything that moves the
   * cell underneath it would leave the panel floating over unrelated rows, and
   * a stale panel is worse than no panel. `capture: true` so a scroll inside
   * the table's own scrollport is heard, not just one on the window.
   */
  useEffect(() => {
    if (!rect) return;
    const shut = () => setRect(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') shut();
    };
    window.addEventListener('scroll', shut, true);
    window.addEventListener('resize', shut);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', shut, true);
      window.removeEventListener('resize', shut);
      document.removeEventListener('keydown', onKey);
    };
  }, [rect]);

  /* Never leave a timer running past unmount — a report renders hundreds of
     these and every one of them can be scrolled out of existence mid-grace. */
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  /* NOTHING TO EXPAND. A dash must not sprout a panel — and must not be
     focusable, or tabbing through a report stops on every blank cell. */
  if (!text) return <span className="text-muted-foreground">{empty}</span>;

  return (
    <>
      {/*
       * FOCUSABLE, so the keyboard reaches it. `tabIndex={0}` on a span is
       * right here: it is not a control, it performs no action, and making it a
       * button would announce it as one to a screen reader and put a press
       * target in every cell of a report.
       */}
      <span
        ref={cellRef}
        tabIndex={0}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        className={cn(
          'block truncate rounded outline-none',
          /* A HINT THAT THERE IS MORE, rather than a hard edge. The underline
             appears on hover, so a column of these reads as text until you
             reach for one — a permanent affordance on every cell would make a
             report look like a wall of links. */
          'decoration-border decoration-dotted underline-offset-[3px]',
          'transition-colors duration-fast hover:underline',
          'focus-visible:ring-2 focus-visible:ring-ring/50',
          className,
        )}
      >
        {text}
      </span>
      {rect &&
        createPortal(
          <div
            role="tooltip"
            /* The panel keeps ITSELF open: entering it cancels the close the
               cell scheduled, and leaving it schedules a new one. This is the
               half a CSS-only solution cannot express across a portal. */
            onMouseEnter={open}
            onMouseLeave={close}
            style={{
              top: rect.top + 6,
              left: rect.left,
              /* At least as wide as the cell so it reads as the same value
                 expanding, and free to grow past it — a long reason in an 18rem
                 column needs more room than the column has, which is the entire
                 point. */
              minWidth: rect.width,
            }}
            className={cn(
              'fixed z-50 w-max max-w-sm',
              'cursor-text select-text whitespace-pre-wrap break-words',
              'rounded-xl bg-popover px-3.5 py-2.5',
              'text-start text-xs font-normal normal-case leading-relaxed text-foreground',
              'shadow-float ring-1 ring-border/60',
              'animate-fade-in',
            )}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
