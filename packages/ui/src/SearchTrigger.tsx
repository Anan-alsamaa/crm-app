import type { ButtonHTMLAttributes, JSX } from 'react';
import { cn } from './cn.js';
import { SearchIcon } from './Icon.js';

/*
 * SearchTrigger — a search-field-looking button for the top bar that opens the
 * command palette. Styled as an inset search field (subtle border + tinted fill,
 * no drop shadow) so it sits flush inside the white navbar rather than floating
 * like a card. Leading magnifier, a "Search…" placeholder, and a plain ⌘ + K
 * hint. It's a trigger, not a real input — click or Cmd/Ctrl+K opens the one
 * palette, where the actual typing and clearing happen.
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
        'group flex h-9 items-center gap-2.5 rounded-lg border border-border bg-secondary/60 text-sm text-muted-foreground',
        'transition-colors duration-base ease-out',
        'hover:border-border-strong hover:bg-secondary hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
        fullWidth ? 'w-full ps-3 pe-3' : 'ps-3 pe-2.5',
        className,
      )}
      {...rest}
    >
      <SearchIcon size={16} className="shrink-0 text-muted-foreground/70" />
      <span className="flex-1 truncate text-start text-muted-foreground/90">{label}</span>
      <kbd className="hidden shrink-0 font-sans text-2xs font-medium tracking-tight text-muted-foreground/80 sm:inline">
        {meta}
      </kbd>
    </button>
  );
}
