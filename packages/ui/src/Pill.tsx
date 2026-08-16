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
