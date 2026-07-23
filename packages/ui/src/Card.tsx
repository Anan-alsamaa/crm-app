import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from './cn.js';

type Padding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: Padding;
  /** Hover elevation for clickable / focusable cards. */
  interactive?: boolean;
}

const paddings: Record<Padding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6',
};

export function Card({
  padding = 'md',
  interactive = false,
  className,
  children,
  ...rest
}: CardProps): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-2xl bg-card text-card-foreground ring-1 ring-foreground/[0.05] shadow-soft',
        interactive &&
          'transition-[box-shadow,transform] duration-base ease-out hover:shadow-float motion-safe:hover:-translate-y-0.5',
        paddings[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div className={cn('mb-4 flex items-center justify-between gap-3', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="text-md font-semibold text-foreground">{children}</h3>;
}

export function CardSubtitle({ children }: { children: ReactNode }): JSX.Element {
  return <p className="mt-1 text-sm text-muted-foreground">{children}</p>;
}
