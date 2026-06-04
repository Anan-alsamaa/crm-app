import type { HTMLAttributes, JSX } from 'react';
import { cn } from './cn.js';

type Tone =
  | 'neutral'
  | 'primary'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'muted'
  // Editorial / category tones — vivid pastels for tagging.
  | 'pink'
  | 'orange'
  | 'blue'
  | 'purple'
  | 'cyan';
type Size = 'sm' | 'md';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: Size;
  /** Show a leading dot. */
  dot?: boolean;
}

const tones: Record<Tone, string> = {
  neutral: 'bg-secondary text-foreground',
  // A small-text pill on `bg-primary-subtle` (oklch ~0.92) with the default
  // primary (oklch 0.58) only hits 3.96:1 — under WCAG AA. Darken the
  // foreground for inside-pill contrast without touching the global token.
  primary: 'bg-primary-subtle text-[oklch(0.42_0.10_196)]',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/20 text-warning-foreground',
  destructive: 'bg-destructive/15 text-destructive',
  muted: 'bg-muted text-muted-foreground',
  // Vivid category fills — soft tint + saturated label.
  pink: 'bg-[oklch(0.93_0.07_0)] text-[oklch(0.50_0.20_0)]',
  orange: 'bg-[oklch(0.94_0.07_55)] text-[oklch(0.52_0.17_45)]',
  blue: 'bg-[oklch(0.94_0.05_240)] text-[oklch(0.48_0.18_245)]',
  purple: 'bg-[oklch(0.94_0.06_300)] text-[oklch(0.48_0.20_295)]',
  cyan: 'bg-[oklch(0.94_0.05_200)] text-[oklch(0.46_0.13_205)]',
};

const dotColors: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground',
  pink: 'bg-[oklch(0.65_0.22_0)]',
  orange: 'bg-[oklch(0.65_0.18_50)]',
  blue: 'bg-[oklch(0.58_0.20_245)]',
  purple: 'bg-[oklch(0.58_0.22_295)]',
  cyan: 'bg-[oklch(0.58_0.15_205)]',
};

const sizes: Record<Size, string> = {
  sm: 'text-2xs px-2 h-5',
  md: 'text-xs px-2.5 h-6',
};

const dotByDefault: Record<Tone, boolean> = {
  neutral: false,
  primary: false,
  success: false,
  warning: true,
  destructive: true,
  muted: false,
  pink: false,
  orange: false,
  blue: false,
  purple: false,
  cyan: false,
};

export function Pill({
  tone = 'neutral',
  size = 'sm',
  dot,
  className,
  children,
  ...rest
}: PillProps): JSX.Element {
  const showDot = dot ?? dotByDefault[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
        tones[tone],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {showDot && <span className={cn('h-1.5 w-1.5 rounded-full', dotColors[tone])} aria-hidden />}
      {children}
    </span>
  );
}
