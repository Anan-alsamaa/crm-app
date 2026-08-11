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
 *
 * `tone` picks the surface it sits on. The default `light` is the white navbar.
 * `dark` is for the brand rail surface (the agent portal's dark utility bar),
 * where the light tokens would render near-invisible: it lifts the fill with
 * white alphas over the teal rather than tinting a dark accent down, and holds
 * the label at 8:1+ on `--rail`.
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
  /** Surface this sits on. `dark` = the brand rail bar. Defaults to `light`. */
  tone?: 'light' | 'dark';
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
  tone = 'light',
  'aria-label': ariaLabel,
  ...rest
}: SearchTriggerProps): JSX.Element {
  const meta = isApplePlatform() ? '⌘K' : 'Ctrl K';
  const isDark = tone === 'dark';
  return (
    <button
      type={type}
      aria-label={ariaLabel ?? label}
      className={cn(
        'group flex items-center gap-2.5 rounded-full text-sm',
        'ring-1 ring-inset',
        'transition-[background-color,box-shadow,color] duration-base ease-out',
        'focus-visible:outline-none focus-visible:ring-2',
        isDark &&
          'bg-white/[0.10] text-rail-foreground/80 ring-white/15 hover:bg-white/[0.16] hover:text-rail-foreground hover:ring-white/25 focus-visible:ring-rail-foreground/60',
        !isDark &&
          'bg-secondary/50 text-muted-foreground ring-border/70 shadow-sm shadow-foreground/[0.03] hover:bg-secondary hover:text-foreground hover:ring-primary/30 hover:shadow-md hover:shadow-foreground/[0.06] focus-visible:ring-primary/50',
        fullWidth ? 'h-10 w-full ps-4 pe-2' : 'h-9 ps-3.5 pe-2',
        className,
      )}
      {...rest}
    >
      <SearchIcon
        size={16}
        className={cn(
          'shrink-0 transition-colors duration-base ease-out',
          isDark
            ? 'text-rail-foreground/65 group-hover:text-rail-foreground'
            : 'text-muted-foreground/70 group-hover:text-primary',
        )}
      />
      <span
        className={cn(
          'flex-1 truncate text-start',
          isDark ? 'text-rail-foreground/80' : 'text-muted-foreground/90',
        )}
      >
        {label}
      </span>
      <kbd
        className={cn(
          'hidden shrink-0 items-center rounded-md border px-1.5 py-0.5',
          'font-sans text-[10px] font-semibold tracking-tight shadow-sm sm:inline-flex',
          isDark
            ? 'border-white/20 bg-white/10 text-rail-foreground/75'
            : 'border-border/80 bg-background/70 text-muted-foreground/80',
        )}
      >
        {meta}
      </kbd>
    </button>
  );
}
