import {
  cloneElement,
  isValidElement,
  useId,
  type JSX,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from './cn.js';

export interface FormFieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Label + control + optional hint or inline error.
 *
 * The label is associated with its control automatically: when the caller
 * doesn't pass `htmlFor` (and the single child has no `id`), a generated id is
 * injected into the control and used as the label's `htmlFor`. This keeps the
 * label/field pairing accessible (and reachable via `getByLabel`) without every
 * call site wiring ids by hand.
 */
export function FormField({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: FormFieldProps): JSX.Element {
  const autoId = useId();
  const childEl = isValidElement(children) ? (children as ReactElement<{ id?: string }>) : null;
  const controlId = htmlFor ?? childEl?.props.id ?? autoId;
  // Only inject when the caller hasn't taken control of the association.
  const control =
    !htmlFor && childEl && childEl.props.id == null
      ? cloneElement(childEl, { id: controlId })
      : children;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label
          htmlFor={controlId}
          className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
        >
          {label}
        </label>
      )}
      {control}
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
