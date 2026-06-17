import type { ButtonHTMLAttributes, JSX } from 'react';
import { cn } from './cn.js';
import { SearchIcon } from './Icon.js';

/*
 * SearchTrigger — a search-field-looking button for the top bar that opens the
 * command palette. It is purely a trigger: it renders as a rounded, muted pill
 * with a search icon, label, and a ⌘K / Ctrl K keyboard hint (hidden on small
 * screens). The owning portal wires `onClick` to the same open path Cmd/Ctrl+K
 * uses, so click and keyboard share one palette.
 */

export interface SearchTriggerProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  /** Visible placeholder-style label, e.g. "Search…". */
  label: string;
  /** Accessible label for screen readers (defaults to `label`). */
  'aria-label'?: string;
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
  'aria-label': ariaLabel,
  ...rest
}: SearchTriggerProps): JSX.Element {
  const meta = isApplePlatform() ? '⌘K' : 'Ctrl K';
  return (
    <button
      type={type}
      aria-label={ariaLabel ?? label}
      className={cn(
        'group inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-secondary/50 ps-2.5 pe-1.5 text-sm text-muted-foreground',
        'transition-[background-color,border-color,color] duration-fast ease-out',
        'hover:border-border-strong hover:bg-secondary hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        className,
      )}
      {...rest}
    >
      <SearchIcon size={15} className="shrink-0" />
      <span className="truncate">{label}</span>
      <kbd className="ms-1 hidden shrink-0 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-2xs text-muted-foreground sm:inline">
        {meta}
      </kbd>
    </button>
  );
}
