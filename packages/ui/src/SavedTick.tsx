import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { cn } from './cn.js';

/**
 * "Saved ✓", inline, next to the thing that was saved.
 *
 * A toast in the corner is easy to miss and says nothing about WHICH edit it
 * refers to when several fields are on screen. This appears beside the control
 * the user just changed, so the confirmation and the change are in the same
 * glance, then fades rather than accumulating.
 */
export interface SavedTickProps {
  /**
   * Flips to true when a save succeeds. Every rising edge shows the tick
   * again, so repeated saves each confirm rather than only the first.
   */
  saved: boolean;
  /** How long it stays, in ms. */
  holdMs?: number;
  label?: string;
  className?: string;
}

export function SavedTick({
  saved,
  holdMs = 2200,
  label = 'Saved',
  className,
}: SavedTickProps): JSX.Element | null {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!saved) return;
    setShow(true);
    const id = setTimeout(() => setShow(false), holdMs);
    return () => clearTimeout(id);
  }, [saved, holdMs]);

  if (!show) return null;
  return (
    <span
      role="status"
      className={cn(
        'inline-flex items-center gap-1 text-2xs font-semibold text-success',
        'motion-safe:animate-rise-in',
        className,
      )}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5"
        aria-hidden
      >
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
      {label}
    </span>
  );
}
