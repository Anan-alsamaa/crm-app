import type { JSX, ReactNode } from 'react';
import { cn } from './cn.js';

export interface PageHeaderProps {
  /** Title prefix (rendered bold, in display ink). */
  title: ReactNode;
  /**
   * Optional accent word in primary teal — the "Roasted this morning." line
   * from the host page. Drop in a single phrase to get the brand-accent move.
   */
  accent?: ReactNode;
  /** One-line subtitle in muted text. */
  subtitle?: ReactNode;
  /** Optional jade eyebrow chip content (e.g. "● new · single-origin"). */
  eyebrow?: ReactNode;
  /** Trailing actions (buttons, filters) rendered at the start side. */
  actions?: ReactNode;
  /** Override the title size when needed; default ramps up by surface size. */
  size?: 'md' | 'lg' | 'xl';
  className?: string;
}

const sizes: Record<NonNullable<PageHeaderProps['size']>, string> = {
  md: 'text-xl sm:text-2xl',
  lg: 'text-2xl sm:text-3xl',
  xl: 'text-3xl sm:text-4xl',
};

/**
 * Board-grade page header for product surfaces: jade eyebrow chip + big
 * display title with a jade accent word + muted subtitle, actions at the end
 * side, in a generous vertical rhythm.
 *
 * Pair with a `bg-transparent` page wrapper so the near-black canvas shows
 * through behind it.
 */
export function PageHeader({
  title,
  accent,
  subtitle,
  eyebrow,
  actions,
  size = 'lg',
  className,
}: PageHeaderProps): JSX.Element {
  return (
    <header
      className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}
    >
      <div className="space-y-3">
        {eyebrow && (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-primary/15 px-2.5 text-2xs font-semibold uppercase tracking-[0.12em] text-primary ring-1 ring-inset ring-primary/25">
            {eyebrow}
          </span>
        )}
        <h2
          className={cn(
            'font-bold text-display leading-[1.1] tracking-tight text-balance',
            sizes[size],
          )}
        >
          {title}
          {accent && (
            <>
              {' '}
              <span className="text-primary">{accent}</span>
            </>
          )}
        </h2>
        {subtitle && (
          <p className="max-w-prose text-sm text-muted-foreground leading-relaxed">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
