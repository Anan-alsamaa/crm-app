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
  const meta = isApplePlatform() ? '⌘K' : 'Ctrl K';
  return (
    <button
      type={type}
      aria-label={ariaLabel ?? label}
      className={cn(
        'group flex items-center gap-2.5 rounded-full text-sm text-muted-foreground',
        'bg-secondary/50 ring-1 ring-inset ring-border/70',
        'shadow-sm shadow-foreground/[0.03]',
        'transition-[background-color,box-shadow,color] duration-base ease-out',
        'hover:bg-secondary hover:text-foreground hover:ring-primary/30 hover:shadow-md hover:shadow-foreground/[0.06]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        fullWidth ? 'h-10 w-full ps-4 pe-2' : 'h-9 ps-3.5 pe-2',
        className,
      )}
      {...rest}
    >
      <SearchIcon
        size={16}
        className="shrink-0 text-muted-foreground/70 transition-colors duration-base ease-out group-hover:text-primary"
      />
      <span className="flex-1 truncate text-start text-muted-foreground/90">{label}</span>
      <kbd
        className={cn(
          'hidden shrink-0 items-center rounded-md border border-border/80 bg-background/70 px-1.5 py-0.5',
          'font-sans text-[10px] font-semibold tracking-tight text-muted-foreground/80 shadow-sm sm:inline-flex',
        )}
      >
        {meta}
      </kbd>
    </button>
  );
}
