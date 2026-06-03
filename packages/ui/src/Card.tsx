import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from './cn.js';

type Padding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: Padding;
}

const paddings: Record<Padding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6',
};

export function Card({ padding = 'md', className, children, ...rest }: CardProps): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground',
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
