import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@yiji/ui';

/*
 * THE PERFORMANCE PAGE'S METRIC CARD (owner, 2026-10-25: the KPI cards "still
 * look old").
 *
 * The admin reports' card anatomy (`ReportKpi`), so a number reads the same in
 * both portals: the label on top where the eye starts, a round icon chip
 * opposite it, the numeral large underneath, and one quiet supporting line at
 * the foot - the average/median note, a share, or "No data in range" when
 * there is nothing to show. Every card in a row is the same height whether or
 * not it has a foot.
 *
 * `tone` still means "is this metric healthy" (owner, 2026-10-07), carried by
 * the chip and a dot on the foot rather than a tinted surface: the numeral
 * stays ink, the strongest contrast there is.
 *
 * DOM order is value, label, chip, foot: the page tests read a tile as "the
 * first child of the label's parent", and the grid places each part.
 * Shared by the Chats, Tickets and Coupons tabs.
 */

export type TileHue = 'blue' | 'violet' | 'green' | 'amber';

const CHIP: Record<TileHue | 'good' | 'bad', string> = {
  blue: 'bg-sky-tint text-[oklch(0.5_0.16_264)]',
  violet: 'bg-violet-tint text-violet',
  green: 'bg-success-tint text-[oklch(0.5_0.13_155)]',
  amber: 'bg-warning-tint text-warning',
  good: 'bg-success-tint text-[oklch(0.5_0.13_155)]',
  bad: 'bg-destructive-tint text-destructive',
};

const isEmpty = (v: string) => v === '' || v === '—' || v === '-' || v === '–';

export function Tile({
  label,
  value,
  hint,
  tone = 'plain',
  hue = 'blue',
  icon,
  meter,
}: {
  label: string;
  value: string;
  /** The supporting line at the foot. */
  hint?: string;
  tone?: 'plain' | 'good' | 'bad';
  /** The chip's colour when the metric carries no health judgement. */
  hue?: TileHue;
  /** Drawn in the round chip opposite the label. */
  icon?: ReactNode;
  /** Optional data accent at the foot - pass a `<MeterBar>`. */
  meter?: ReactNode;
}) {
  const { t } = useTranslation();
  const empty = isEmpty(value);
  const foot =
    hint ?? (empty ? t('performance.noDataInRange', { defaultValue: 'No data in range' }) : null);
  return (
    <div
      /* The agent skin's KPI surface (index.css `[data-report-kpi]`). */
      data-report-kpi=""
      data-empty={empty ? '' : undefined}
      className={cn(
        'relative grid min-h-[8.25rem] grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] gap-x-3',
        'rounded-[1.375rem] bg-card p-5 ring-1 ring-foreground/[0.06] shadow-soft',
      )}
    >
      <div
        className={cn(
          'col-span-2 row-start-2 mt-3 self-end truncate text-[2.125rem] font-semibold leading-none tabular-nums tracking-[-0.035em]',
          empty ? 'text-muted-foreground/70' : 'text-foreground',
        )}
      >
        {value}
      </div>
      <div className="col-start-1 row-start-1 min-w-0 self-center text-[0.9375rem] font-semibold leading-snug text-foreground/80">
        <span className="line-clamp-2">{label}</span>
      </div>
      <span
        aria-hidden
        className={cn(
          'col-start-2 row-start-1 grid h-10 w-10 place-items-center rounded-full',
          CHIP[tone === 'plain' ? hue : tone],
        )}
      >
        {icon}
      </span>
      {/* One line, the same height on every card - a meter sits INSIDE it,
          so a card with one never pushes its numeral out of line. */}
      <div className="col-span-2 row-start-3 mt-2 flex h-4 min-w-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
        {meter && <span className="w-10 shrink-0">{meter}</span>}
        {foot && tone !== 'plain' && !empty && (
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              tone === 'bad' ? 'bg-destructive' : 'bg-success',
            )}
          />
        )}
        {foot && <span className="truncate">{foot}</span>}
      </div>
    </div>
  );
}

/**
 * A row of tiles: one uniform grid, full width, one gap. `count` sets how many
 * sit across on a wide screen so a row never ends in an orphan; two across on a
 * tablet, one on a phone.
 */
export function TileGrid({
  count,
  label,
  children,
}: {
  count: 4 | 5 | 7;
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'grid grid-cols-1 gap-4 min-[30rem]:grid-cols-2',
        count === 4 && 'lg:grid-cols-4',
        count === 5 && 'lg:grid-cols-5',
        count === 7 && 'lg:grid-cols-4 xl:grid-cols-7',
      )}
    >
      {children}
    </section>
  );
}

/* ── The page's tables: one roomy anatomy for all three tabs ─────────────── */

/** A light header: sentence-case labels on a faint band, not a tracked caps strip. */
export const PERF_HEAD_ROW =
  'bg-foreground/[0.025] text-xs text-muted-foreground shadow-[inset_0_-1px_0_oklch(var(--foreground)/0.07)]';
export const PERF_TH = 'h-11 px-5 text-start font-semibold whitespace-nowrap';
export const PERF_TD = 'px-5 py-3.5';
export const PERF_BODY_ROW =
  'cursor-pointer border-t border-foreground/[0.06] transition-colors duration-fast hover:bg-primary/[0.05]';
/** The card a table sits in. No inner scroller: the PAGE scrolls. */
export const PERF_TABLE_CARD =
  'rounded-[1.375rem] bg-card shadow-[var(--agent-card-shadow)] ring-1 ring-foreground/[0.06]';
