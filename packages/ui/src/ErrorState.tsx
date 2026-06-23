import type { JSX, ReactNode } from 'react';
import { cn } from './cn.js';
import { Button } from './Button.js';

export interface ErrorStateProps {
  /** Headline. Defaults to a generic "Something went wrong". */
  title?: ReactNode;
  /** Optional supporting copy under the title. */
  message?: ReactNode;
  /** Optional retry handler — renders a "Retry" button when provided. */
  onRetry?: () => void;
  /** Override the default alert glyph. */
  icon?: ReactNode;
  /** Label for the retry button (defaults to "Retry"). */
  retryLabel?: ReactNode;
  className?: string;
}

/**
 * Graceful failure state for data queries — the error-path sibling of
 * {@link EmptyState}. Use it when a query reports `isError` so the UI shows an
 * actionable retry affordance instead of an endless skeleton.
 *
 * Strings default to plain English so it renders sensibly even if a caller
 * forgets to translate; callers should pass i18n'd values via props.
 */
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  icon,
  retryLabel = 'Retry',
  className,
}: ErrorStateProps): JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-4 px-6 py-20 text-center',
        className,
      )}
    >
      <div className="text-destructive/70">{icon ?? <AlertIcon size={40} />}</div>
      <div className="space-y-1.5">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">{title}</h3>
        {message && <p className="mx-auto max-w-md text-sm text-muted-foreground">{message}</p>}
      </div>
      {onRetry && (
        <div className="mt-2">
          <Button type="button" variant="outline" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function AlertIcon({ size = 40 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}
