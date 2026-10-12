import type { ReactNode } from 'react';
import { cn } from '@yiji/ui';

/* The boards' KPI chip fills — `--<hue>-tint` + hue pairs, matching the
 * Overview's KPI row so the two console dashboards read as one system.
 * `--warning` stays out: its glyph contrast on the tint fails 3:1 on light.
 *
 * Moved out of the page (owner, 2026-10-12) so the Tickets and Coupons tabs
 * draw their headline numbers with the same tile as the Chats tab. */
const TILE_CHIPS = {
  neutral: 'bg-secondary text-foreground',
  sky: 'bg-sky-tint text-sky',
  violet: 'bg-violet-tint text-violet',
  success: 'bg-success-tint text-success',
  destructive: 'bg-destructive-tint text-destructive',
} as const;

/** One headline number — board anatomy: icon chip, hue numeral, micro-label, optional data accent. */
export function Tile({
  label,
  value,
  hint,
  tone = 'plain',
  chip = 'neutral',
  icon,
  visual,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'plain' | 'good' | 'bad';
  /** Chip hue — the tile's identity color, independent of the value's verdict. */
  chip?: keyof typeof TILE_CHIPS;
  icon?: ReactNode;
  visual?: ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-card p-4 shadow-soft ring-1 ring-foreground/[0.06]">
      <div className="flex items-start gap-3">
        {icon && (
          <span
            aria-hidden
            className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', TILE_CHIPS[chip])}
          >
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'text-2xl font-extrabold leading-none tracking-[-0.03em] tabular-nums',
              tone === 'bad'
                ? 'text-destructive'
                : tone === 'good'
                  ? 'text-success'
                  : 'text-foreground',
            )}
          >
            {value}
          </div>
          {/* Wraps rather than truncates: at six-up these labels used to shear
              to "ANSWERED W…", which is a label that names nothing. */}
          <div className="mt-2 text-2xs font-semibold uppercase leading-snug tracking-[0.12em] text-muted-foreground">
            {label}
            {hint && <span className="ms-1 font-normal normal-case tracking-normal">({hint})</span>}
          </div>
        </div>
        {visual && <div className="shrink-0 self-center">{visual}</div>}
      </div>
    </div>
  );
}
