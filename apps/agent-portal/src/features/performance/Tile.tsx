import type { ReactNode } from 'react';
import { cn } from '@yiji/ui';

/** One headline number, in the board tile anatomy: extrabold numeral, tone dot
    beside the uppercase micro-label, optional meter accent underneath. Shared by
    the Chats, Tickets and Coupons tabs (owner, 2026-10-07). */
export function Tile({
  label,
  value,
  hint,
  tone = 'plain',
  meter,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'plain' | 'good' | 'bad';
  /** Optional data accent under the label — pass a `<MeterBar>`. */
  meter?: ReactNode;
}) {
  return (
    /* The surface carries the tone as well as the numeral. Unlike the hue-coded
       KPI cards elsewhere, `tone` here means "is this metric healthy" — so a
       tinted surface is information, not decoration, and it pulls the eye to
       the two tiles that need attention instead of leaving seven identical
       white boxes to be read one at a time. */
    <div
      className={cn(
        'rounded-2xl px-4 py-3.5 shadow-soft ring-1',
        tone === 'bad'
          ? 'bg-gradient-to-br from-destructive-tint/70 to-card ring-destructive/15'
          : tone === 'good'
            ? 'bg-gradient-to-br from-success-tint/70 to-card ring-success/15'
            : 'bg-card ring-foreground/[0.06]',
      )}
    >
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
      <div className="mt-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {tone !== 'plain' && (
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              tone === 'bad' ? 'bg-destructive' : 'bg-success',
            )}
          />
        )}
        {/* Wraps rather than truncates: at six-up these micro-labels were
            clipping to "COMMON CHATS TA…", which is not a label at all. */}
        <span className="min-w-0 leading-snug">
          {label}
          {hint && <span className="ms-1 font-normal normal-case tracking-normal">({hint})</span>}
        </span>
      </div>
      {meter}
    </div>
  );
}
