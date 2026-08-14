import type { JSX, ReactNode } from 'react';
import { cn } from './cn.js';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 px-6 py-20 text-center',
        className,
      )}
    >
      {icon && (
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary-tint text-primary">
          {icon}
        </div>
      )}
      <div className="space-y-1.5">
        <h3 className="font-display text-lg font-bold tracking-tight text-foreground">{title}</h3>
        {description && (
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
