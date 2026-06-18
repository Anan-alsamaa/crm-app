import type { ButtonHTMLAttributes, JSX } from 'react';
import { cn } from './cn.js';
import { SearchIcon } from './Icon.js';

/*
 * SearchTrigger — a search-field-looking button for the top bar that opens the
 * command palette. Purely a trigger: it renders as a rounded search field with a
 * leading icon, a placeholder-style label, and a ⌘K / Ctrl K hint on the right.
 * The owning portal wires `onClick` to the same open path Cmd/Ctrl+K uses, so
 * click and keyboard share one palette.
 *
 * `fullWidth` makes it a centered, full-width field (for the middle of the top
 * bar); the default compact pill is for tight spots like the mobile action row.
 */

export interface SearchTriggerProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  /** Visible placeholder-style label, e.g. "Search…". */
  label: string;
  /** Accessible label for screen readers (defaults to `label`). */
  'aria-label'?: string;
  /** Stretch to fill its container (icon+label left, ⌘K right). */
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
        'group flex items-center gap-2 rounded-xl border border-border/70 bg-secondary/40 text-sm text-muted-foreground',
        'transition-[background-color,border-color,color,box-shadow] duration-base ease-out',
        'hover:border-border-strong hover:bg-card hover:text-foreground hover:shadow-sm hover:shadow-foreground/[0.05]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35',
        fullWidth ? 'h-9 w-full justify-between ps-3 pe-2' : 'h-8 justify-between ps-2.5 pe-1.5',
        className,
      )}
      {...rest}
    >
      <span className="flex min-w-0 items-center gap-2">
        <SearchIcon size={15} className="shrink-0 transition-colors group-hover:text-primary" />
        <span className="truncate">{label}</span>
      </span>
      <kbd className="ms-2 hidden shrink-0 items-center rounded-md border border-border bg-card/80 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground sm:inline-flex">
        {meta}
      </kbd>
    </button>
  );
}
