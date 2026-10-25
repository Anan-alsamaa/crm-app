import { useEffect, useState } from 'react';
import type { JSX, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@yiji/ui';

/**
 * A visible way to reach the columns that are off the right edge.
 *
 * The page already scrolls sideways and its scrollbar already sits at the foot
 * of the screen rather than under the last row — which was the ask. It was
 * still not enough: a 12px native bar at the very bottom of a window is easy
 * to miss entirely, and nothing on screen SAYS there are more columns. A table
 * that continues past the edge looks exactly like a table that ends there.
 *
 * So: a small pinned control that says how much is hidden and moves the port a
 * screenful at a time. Three deliberate choices —
 *
 *   - it is only rendered while there IS overflow, so it never sits there
 *     doing nothing;
 *   - the label counts COLUMNS, not pixels, because columns are the thing the
 *     reader is looking for;
 *   - the buttons page by ~80% of the viewport rather than a fixed step, so
 *     one press always lands somewhere useful whatever the screen.
 *
 * Sticky to the bottom of the scrollport and to its start edge, so it holds
 * still on both axes while the table moves underneath.
 *
 * WHICH ELEMENT SCROLLS. The PAGE body (`portRef`). The wide reports let the
 * page scroll sideways (`TableSurface flow`): the redesign briefly moved that
 * scroll inside each table's card, and the owner asked for it back on the
 * page (2026-10-25) - "for operations, page level is simpler". In Arabic the
 * later columns are off the LEFT edge and `scrollLeft` runs negative, which
 * the measurement and the nudge both allow for.
 */
export function ColumnScroller({
  portRef,
  className,
}: {
  /** The element that actually scrolls — the report's page body. */
  portRef: RefObject<HTMLElement | null>;
  className?: string;
}): JSX.Element | null {
  const { t } = useTranslation();
  const [state, setState] = useState({ max: 0, left: 0, hidden: 0 });

  useEffect(() => {
    const port = portRef.current;
    if (!port) return;

    const measure = () => {
      const max = port.scrollWidth - port.clientWidth;
      // How many column headers are not fully on screen. Counted from the DOM
      // rather than divided out of the width, because columns are not equal
      // widths and "3 more columns" has to be true.
      // Past the END edge - in Arabic the later columns are off the LEFT.
      const heads = Array.from(port.querySelectorAll('thead th'));
      const box = port.getBoundingClientRect();
      const rtl = getComputedStyle(port).direction === 'rtl';
      const hidden = heads.filter((th) => {
        const r = th.getBoundingClientRect();
        return rtl ? r.left < box.left - 1 : r.right > box.right + 1;
      }).length;
      // scrollLeft runs negative in RTL; the distance travelled is what counts.
      const left = Math.abs(port.scrollLeft);
      setState((prev) =>
        prev.max === max && prev.left === left && prev.hidden === hidden
          ? prev
          : { max, left, hidden },
      );
    };

    measure();
    port.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    let ro: ResizeObserver | undefined;
    // Guarded — this is an affordance, and it must never take the report down
    // in an environment without ResizeObserver (jsdom).
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(port);
      const table = port.querySelector('table');
      if (table) ro.observe(table);
    }
    return () => {
      port.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  });

  // Nothing hidden, nothing to offer.
  if (state.max <= 4) return null;

  const step = () => Math.max(160, (portRef.current?.clientWidth ?? 600) * 0.8);
  const nudge = (dir: -1 | 1) => {
    const el = portRef.current;
    if (!el) return;
    // "Later" is leftward in RTL, where scrollLeft counts down from 0.
    const rtl = getComputedStyle(el).direction === 'rtl';
    el.scrollBy({ left: (rtl ? -dir : dir) * step(), behavior: 'smooth' });
  };

  const atStart = state.left <= 1;
  const atEnd = state.left >= state.max - 1;

  return (
    <div
      className={cn(
        'pointer-events-none sticky bottom-0 start-0 z-20 flex w-[var(--pin-w,100%)] justify-end',
        className,
      )}
    >
      <div
        className={cn(
          'pointer-events-auto mb-2 flex items-center gap-1 rounded-full px-1.5 py-1',
          'bg-card/95 shadow-float ring-1 ring-foreground/10 backdrop-blur',
        )}
      >
        <span className="px-2 text-2xs font-medium tabular-nums text-muted-foreground">
          {atEnd
            ? t('complaintReport.allColumns', { defaultValue: 'All columns shown' })
            : t('complaintReport.moreColumns', {
                count: state.hidden,
                defaultValue: '{{count}} more columns →',
              })}
        </span>
        <Nudge
          onClick={() => nudge(-1)}
          disabled={atStart}
          label={String(t('complaintReport.scrollLeft', { defaultValue: 'Earlier columns' }))}
          glyph="‹"
        />
        <Nudge
          onClick={() => nudge(1)}
          disabled={atEnd}
          label={String(t('complaintReport.scrollRight', { defaultValue: 'Later columns' }))}
          glyph="›"
        />
      </div>
    </div>
  );
}

function Nudge({
  onClick,
  disabled,
  label,
  glyph,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  glyph: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-full text-sm leading-none transition-colors duration-fast',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        disabled
          ? 'text-muted-foreground/40'
          : 'bg-secondary text-foreground hover:bg-primary hover:text-primary-foreground',
      )}
    >
      {glyph}
    </button>
  );
}
