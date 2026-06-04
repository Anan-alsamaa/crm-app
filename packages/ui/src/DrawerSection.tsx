import type { JSX, ReactNode } from 'react';
import { cn } from './cn.js';

export interface DrawerSectionProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Grouped section inside a Drawer body. Use one per logical block of fields
 * (e.g. Identity / Access / Locale on a Create User drawer) so the form reads
 * as a stack of meaningful chunks instead of one long list of inputs.
 */
export function DrawerSection({
  title,
  description,
  children,
  className,
}: DrawerSectionProps): JSX.Element {
  return (
    <section className={cn('space-y-4 pt-2 first:pt-0', className)}>
      <div className="space-y-1">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h3>
        {description && <p className="text-sm leading-relaxed text-foreground/80">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
