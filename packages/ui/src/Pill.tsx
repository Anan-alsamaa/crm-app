import type { HTMLAttributes, JSX } from 'react';
import { cn } from './cn.js';

type Tone =
  | 'neutral'
  | 'primary'
  | 'success'
  /** Excel-yellow: WAITING on somebody. Not a severity — see `tones` below. */
  | 'highlight'
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
  // Neutral/muted fills sit close to the card surface, so a hairline inset
  // ring gives them an edge on both themes without adding a border color.
  neutral: 'bg-secondary text-foreground ring-1 ring-inset ring-foreground/[0.06]',
  // Tint + hue token pairs: the tint tracks the theme, so pills stay dim
  // chips on dark and soft pastels on light — no hardcoded lightness.
  primary: 'bg-primary-tint text-primary',
  success: 'bg-success/15 text-success',
  // Warning is a light token — `text-warning` on a tint fails contrast on the
  // light theme, so warning pills use the darkened warning-foreground.
  warning: 'bg-warning/20 text-warning-foreground',
  /* SOLID, not a 20% tint, and dark text on it.
     
     "Pending" is not a severity — nothing is wrong, somebody has not acted yet
     — so it sits outside the warning/error red ramp entirely. A full-strength
     `#FBF719` reads as the spreadsheet highlight it is meant to echo, and the
     tint it replaced rendered white text on pale peach, which could not be
     read at all (owner, 2026-09-28). */
  highlight: 'bg-highlight text-highlight-foreground',
  destructive: 'bg-destructive/15 text-destructive',
  muted: 'bg-muted text-muted-foreground ring-1 ring-inset ring-foreground/[0.06]',
  // Vivid category fills — token tint + saturated hue label per tone.
  pink: 'bg-magenta/15 text-magenta',
  orange: 'bg-warning/20 text-warning-foreground',
  blue: 'bg-sky-tint text-sky',
  purple: 'bg-violet-tint text-violet',
  cyan: 'bg-primary-tint text-primary',
};

const dotColors: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  highlight: 'bg-highlight-foreground',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground',
  pink: 'bg-magenta',
  orange: 'bg-warning',
  blue: 'bg-sky',
  purple: 'bg-violet',
  cyan: 'bg-primary',
};

const sizes: Record<Size, string> = {
  sm: 'text-2xs px-2.5 h-6',
  md: 'text-xs px-3 h-7',
};

const dotByDefault: Record<Tone, boolean> = {
  neutral: false,
  primary: false,
  success: false,
  warning: true,
  // No dot: the fill is already the signal, and a dot on solid yellow is noise.
  highlight: false,
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
