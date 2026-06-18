import type { ButtonHTMLAttributes, JSX } from 'react';
import { cn } from './cn.js';
import { SearchIcon } from './Icon.js';

/*
 * SearchTrigger — a search-field-looking button for the top bar that opens the
 * command palette. A clean search field: leading magnifier, a "Search…"
 * placeholder, and a plain ⌘ + K hint on the right. It's a trigger (not a real
 * input) — click or Cmd/Ctrl+K opens the one palette, where the actual typing
 * and clearing happen, so the trigger itself has no clear (✕) affordance.
 *
 * `fullWidth` makes it the centered, full-width bar in the middle of the top bar;
 * the default compact form is for tight spots like the mobile action row.
 */

export interface SearchTriggerProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  /** Visible placeholder-style label, e.g. "Search…". */
  label: string;
  /** Accessible label for screen readers (defaults to `label`). */
  'aria-label'?: string;
  /** Stretch to fill its container (the centered top-bar search). */
  fullWidth?: boolean;
}

/** True when the platform uses ⌘ (Apple) rather than Ctrl for shortcuts. */
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
}

export function SearchTrigger({
  label,
  className,
  type = 'button',
  fullWidth = false,
  'aria-label': ariaLabel,
  ...rest
}: SearchTriggerProps): JSX.Element {
  const meta = isApplePlatform() ? '⌘ + K' : 'Ctrl + K';
  return (
    <button
      type={type}
      aria-label={ariaLabel ?? label}
      className={cn(
        'group flex h-9 items-center gap-2.5 rounded-xl bg-card text-sm text-muted-foreground',
        'ring-1 ring-border/70 shadow-sm shadow-foreground/[0.03]',
        'transition-[box-shadow,background-color,color] duration-base ease-out',
        'hover:ring-border-strong hover:shadow-md hover:shadow-foreground/[0.06]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35',
        fullWidth ? 'w-full ps-3 pe-3' : 'ps-3 pe-2.5',
        className,
      )}
      {...rest}
    >
      <SearchIcon size={16} className="shrink-0 text-muted-foreground/70" />
      <span className="flex-1 truncate text-start text-muted-foreground/90">{label}</span>
      <kbd className="hidden shrink-0 font-sans text-xs font-medium tracking-tight text-foreground/55 sm:inline">
        {meta}
      </kbd>
    </button>
  );
}
