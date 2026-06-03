import type { JSX, ReactNode } from 'react';
import { cn } from './cn.js';

export interface FormFieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

/** Label + control + optional hint or inline error. */
export function FormField({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: FormFieldProps): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
        >
          {label}
        </label>
      )}
      {children}
      {error ? (
        <span className="text-xs text-destructive font-medium" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-muted-foreground/80">{hint}</span>
      ) : null}
    </div>
  );
}
