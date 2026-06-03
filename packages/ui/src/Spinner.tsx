import type { JSX } from 'react';
import { cn } from './cn.js';

export interface SpinnerProps {
  size?: number;
  label?: string;
  className?: string;
}

/**
 * Loading spinner. The faster rotation (0.7s) makes loading feel snappier
 * even when latency is identical — perceived performance per emil-design-eng.
 * For larger surfaces, prefer Skeleton over Spinner per impeccable product
 * register.
 */
export function Spinner({ size = 14, label = 'Loading', className }: SpinnerProps): JSX.Element {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block rounded-full border-2 border-current border-t-transparent opacity-80',
        'motion-safe:animate-spin',
        className,
      )}
      style={{ width: size, height: size, animationDuration: '0.7s' }}
    />
  );
}

/**
 * Skeleton placeholder. Match the final layout's shape, not a generic block.
 */
export function Skeleton({ className }: { className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'block animate-shimmer rounded-lg bg-gradient-to-r from-secondary/60 via-secondary to-secondary/60 bg-[length:200%_100%]',
        className,
      )}
    />
  );
}
