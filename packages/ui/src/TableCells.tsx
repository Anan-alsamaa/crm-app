import type { JSX, ReactNode } from 'react';
import { cn } from './cn.js';

/*
 * RICHER TABLE CELLS (owner, 2026-10-15: "the table UI is very boring"; the
 * reference shows a logo tile + name + sub-line, inline progress bars, soft
 * status pills and a titled table header with a count).
 *
 * Colour: light shades of SEVERAL hues, not only the brand indigo (owner,
 * same day) - each name gets a stable hue so a column reads as a set.
 */

/* Light tile + matching ink, per hue. Built from existing tint tokens plus two
 * literal pastels (pink, cyan) the token set does not carry. */
const IDENTITY_TONES = [
  'bg-violet-tint text-violet',
  'bg-sky-tint text-sky',
  'bg-success-tint text-success',
  'bg-warning-tint text-[oklch(0.5_0.13_70)]',
  'bg-[oklch(0.95_0.04_350)] text-[oklch(0.52_0.18_350)]',
  'bg-[oklch(0.95_0.04_200)] text-[oklch(0.5_0.1_200)]',
  'bg-primary-tint text-primary',
] as const;

function hueIndex(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % IDENTITY_TONES.length;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = [...parts[0]!][0] ?? '';
  const second =
    parts.length > 1 ? ([...parts[parts.length - 1]!][0] ?? '') : ([...parts[0]!][1] ?? '');
  return (first + second).toUpperCase();
}

/**
 * Name cell: a rounded initials tile in a light hue, the name, and an
 * optional quieter second line (an email, a code, a branch).
 */
export function IdentityCell({
  name,
  sub,
  colorKey,
  className,
}: {
  name: string;
  sub?: ReactNode;
  /** What picks the hue; defaults to the name. */
  colorKey?: string;
  className?: string;
}): JSX.Element {
  return (
    <span className={cn('flex min-w-0 items-center gap-3', className)}>
      <span
        aria-hidden
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-xl text-xs font-bold',
          IDENTITY_TONES[hueIndex(colorKey ?? name)],
        )}
      >
        {initials(name)}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-semibold text-foreground" title={name}>
          {name}
        </span>
        {sub != null && sub !== '' && (
          <span className="block truncate text-xs text-muted-foreground">{sub}</span>
        )}
      </span>
    </span>
  );
}

/** Inline progress: a rounded bar and its percentage, as in the reference. */
export function ProgressCell({
  value,
  tone = 'primary',
  className,
}: {
  /** 0-100. */
  value: number;
  tone?: 'primary' | 'success' | 'warning' | 'destructive';
  className?: string;
}): JSX.Element {
  const v = Math.max(0, Math.min(100, value));
  const fill = {
    primary: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    destructive: 'bg-destructive',
  }[tone];
  return (
    <span className={cn('flex min-w-[9rem] items-center gap-3', className)}>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-foreground/[0.07]">
        <span className={cn('block h-full rounded-full', fill)} style={{ width: `${v}%` }} />
      </span>
      <span className="w-10 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
        {Math.round(v)}%
      </span>
    </span>
  );
}

/**
 * The header above a table card: title + count pill, a one-line description,
 * and actions (filter, export, add) at the end.
 */
export function TableCardHeader({
  title,
  count,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  count?: number | string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn('flex flex-wrap items-start justify-between gap-3 px-6 pb-4 pt-5', className)}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
          {count != null && (
            <span className="rounded-full bg-primary-tint px-2 py-0.5 text-2xs font-semibold tabular-nums text-primary">
              {count}
            </span>
          )}
        </div>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
