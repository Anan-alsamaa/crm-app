import type { ButtonHTMLAttributes, JSX } from 'react';
import { cn } from './cn.js';
import { SearchIcon, CloseIcon } from './Icon.js';

/*
 * SearchTrigger — a search-field-looking button for the top bar that opens the
 * command palette. Styled as a clean white search bar: leading magnifier, a
 * "Search…" placeholder, a plain ⌘ + K hint, and a subtle ✕ chip on the right.
 * It's a trigger (not a real input) — click or Cmd/Ctrl+K opens the one palette,
 * where the actual typing + clearing happens. The ✕ is decorative, matching the
 * search-bar look.
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
        'group flex items-center gap-2.5 rounded-2xl bg-card text-sm text-muted-foreground',
        'ring-1 ring-border/70 shadow-sm shadow-foreground/[0.04]',
        'transition-[box-shadow,background-color,color] duration-base ease-out',
        'hover:ring-border-strong hover:shadow-md hover:shadow-foreground/[0.07]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35',
        fullWidth ? 'h-10 w-full ps-3.5 pe-2' : 'h-9 ps-3 pe-2',
        className,
      )}
      {...rest}
    >
      <SearchIcon size={16} className="shrink-0 text-muted-foreground/70" />
      <span className="flex-1 truncate text-start text-muted-foreground/90">{label}</span>
      <kbd className="hidden shrink-0 font-sans text-xs font-medium tracking-tight text-foreground/60 sm:inline">
        {meta}
      </kbd>
      <span
        aria-hidden
        className="ms-0.5 hidden h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground/70 transition-colors duration-fast group-hover:bg-secondary/80 sm:grid"
      >
        <CloseIcon size={11} />
      </span>
    </button>
  );
}
