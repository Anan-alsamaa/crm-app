import type { JSX, ReactNode } from 'react';
import { cn } from './cn.js';
import { Pill } from './Pill.js';

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
  /** Optional coral eyebrow pill content (e.g. "● new · single-origin"). */
  eyebrow?: ReactNode;
  /** Trailing actions (buttons, filters) rendered at the start side. */
  actions?: ReactNode;
  /** Override the title size when needed; default ramps up by surface size. */
  size?: 'md' | 'lg' | 'xl';
  className?: string;
}

const sizes: Record<NonNullable<PageHeaderProps['size']>, string> = {
  md: 'text-2xl sm:text-3xl',
  lg: 'text-3xl sm:text-4xl',
  xl: 'text-4xl sm:text-5xl',
};

/**
 * Marketing-grade page header for product surfaces. Sets the energy from the
 * host-page hero: coral eyebrow + huge bold title with a teal accent line +
 * muted subtitle, in a generous vertical rhythm.
 *
 * Pair with a `bg-transparent` page wrapper so the body's mesh canvas shows
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
          <Pill tone="pink" size="md">
            {eyebrow}
          </Pill>
        )}
        <h2
          className={cn(
            'font-extrabold text-display leading-[1.02] tracking-[-0.035em] text-balance',
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
          <p className="max-w-prose text-base text-muted-foreground leading-relaxed">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
