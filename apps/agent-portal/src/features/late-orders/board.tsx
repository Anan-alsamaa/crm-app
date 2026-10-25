import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@yiji/ui';

/*
 * THE LATE-ORDERS BOARD'S OWN PIECES (owner, 2026-10-22: "a report to be
 * displayed on a TV").
 *
 * Presentation only. Nothing here fetches, filters or decides; the page hands
 * in numbers it already has.
 */

/**
 * HOW LATE, AS A STEP - measured PAST the threshold, because every row on the
 * board is already over it.
 *
 * The board wants a colour scale read from across a room (amber, then red,
 * then solid red). Late and Very late carry a word beside the number; the
 * solid-red step shows NO word (owner, 2026-10-25: "don't need the text
 * critical") - its fill is the loudest on the screen, and the word stays for
 * screen readers only.
 */
export type LateSeverity = 'late' | 'veryLate' | 'critical';

export function lateSeverity(minutesElapsed: number, thresholdMinutes: number): LateSeverity {
  const over = minutesElapsed - thresholdMinutes;
  if (over >= 60) return 'critical';
  if (over >= 30) return 'veryLate';
  return 'late';
}

/*
 * Each pair measured on its own fill (>= 4.5:1): dark amber ink on a pale
 * amber, deep red-orange on its wash, white on the solid destructive red.
 */
const SEVERITY_CLASS: Record<LateSeverity, string> = {
  late: 'bg-[oklch(0.95_0.07_85)] text-[oklch(0.42_0.1_65)]',
  veryLate: 'bg-[oklch(0.94_0.055_40)] text-[oklch(0.47_0.17_36)]',
  critical: 'bg-destructive text-destructive-foreground',
};

/** "1h 12m" - the board's one formatting of a duration (the table's too). */
export function formatLate(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * The time the order has been running, as a chip in its severity colour, with
 * the severity word beside or under it.
 *
 * `size="board"` is the TV figure; `size="table"` fits a 52px table row.
 */
export function LateBy({
  minutes,
  threshold,
  size = 'board',
}: {
  minutes: number;
  threshold: number;
  size?: 'board' | 'table';
}) {
  const { t } = useTranslation();
  const sev = lateSeverity(minutes, threshold);
  const word = t(`lateOrders.board.severity.${sev}`, {
    defaultValue: sev === 'late' ? 'Late' : sev === 'veryLate' ? 'Very late' : 'Critical',
  });
  /* No visible word at any step - the colour carries it on screen; the word
     stays for assistive tech (owner, 2026-10-25). */
  const wordEl = <span className="sr-only">{word}</span>;
  if (size === 'table')
    return (
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        <span
          dir="ltr"
          className={cn(
            'inline-flex h-7 items-center rounded-full px-2.5 text-sm font-bold tabular-nums',
            SEVERITY_CLASS[sev],
          )}
        >
          {formatLate(minutes)}
        </span>
        {wordEl}
      </span>
    );
  return (
    <span className="flex flex-col items-start gap-1">
      <span
        dir="ltr"
        className={cn(
          'inline-flex items-center rounded-2xl px-3 py-1 font-bold leading-none tabular-nums tracking-[-0.02em]',
          /* One step down with the rest of the board (owner, 2026-10-25),
             still the largest figure on it. */
          'text-[1.375rem] 2xl:px-3.5 2xl:text-[1.875rem]',
          SEVERITY_CLASS[sev],
        )}
      >
        {formatLate(minutes)}
      </span>
      {wordEl}
    </span>
  );
}

/* The board's compact row actions. Stroke icons on the portal's 16px grid. */
const ICON = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'h-4 w-4',
  'aria-hidden': true,
};

/** Cart & tracking. */
export function BoardCartIcon() {
  return (
    <svg {...ICON}>
      <path d="M3.5 5.5h9l-.8 7.2a1 1 0 0 1-1 .8H5.3a1 1 0 0 1-1-.8l-.8-7.2Z" />
      <path d="M5.8 5.5V4.6a2.2 2.2 0 0 1 4.4 0v.9" />
    </svg>
  );
}

/** Comment / edit comment. */
export function BoardCommentIcon() {
  return (
    <svg {...ICON}>
      <path d="M2.8 4.2A1.7 1.7 0 0 1 4.5 2.5h7a1.7 1.7 0 0 1 1.7 1.7v5a1.7 1.7 0 0 1-1.7 1.7H7.2L4.4 13v-2.1h.1a1.7 1.7 0 0 1-1.7-1.7v-5Z" />
    </svg>
  );
}

/** Assign coupon. */
export function BoardCouponIcon() {
  return (
    <svg {...ICON}>
      <path d="M2.5 5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1.4a1.6 1.6 0 0 0 0 3.2V11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9.6a1.6 1.6 0 0 0 0-3.2V5Z" />
      <path d="M9.5 4.5v7" strokeDasharray="1.2 1.4" />
    </svg>
  );
}

/**
 * The wall clock in the board's header strip. Its own one-second timer, so
 * the page around it never re-renders for the clock - only this span does.
 */
export function BoardClock({ className }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <time dir="ltr" dateTime={now.toISOString()} className={cn('tabular-nums', className)}>
      {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </time>
  );
}

/** A two-option segmented switch: Board | Table. */
export function ViewSwitch({
  value,
  onChange,
}: {
  value: 'board' | 'table';
  onChange: (next: 'board' | 'table') => void;
}) {
  const { t } = useTranslation();
  const opts = [
    { v: 'board' as const, label: t('lateOrders.board.viewBoard', { defaultValue: 'Board' }) },
    { v: 'table' as const, label: t('lateOrders.board.viewTable', { defaultValue: 'Table' }) },
  ];
  return (
    <div
      role="group"
      aria-label={t('lateOrders.board.view', { defaultValue: 'View' })}
      className="inline-flex h-9 items-center rounded-full bg-foreground/[0.06] p-0.5"
    >
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
          className={cn(
            'inline-flex h-8 items-center rounded-full px-3.5 text-sm font-semibold transition-[background-color,color,box-shadow] duration-fast ease-out',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            value === o.v
              ? 'bg-card text-foreground shadow-[0_2px_8px_-4px_oklch(var(--shadow-color)/0.5)]'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
