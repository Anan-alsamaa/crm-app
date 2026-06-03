import type { JSX, ReactNode } from 'react';
import { useEffect } from 'react';
import { cn } from './cn.js';

/*
 * Side drawer — slides in from the end (start in RTL). The primary
 * pattern for "create new X" flows in admin pages. Keeps the user on the
 * list view (which stays dimmed in the background) instead of bouncing
 * them to a separate page or full-screen modal.
 *
 * Closes on Esc + backdrop click. Animated entrance is gated by
 * `motion-safe`. Body scroll is locked while open.
 */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Drawer width. Defaults to ~480px. */
  width?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  /** Sticky footer actions (Cancel / Save / etc). */
  footer?: ReactNode;
}

const widthClass: Record<NonNullable<DrawerProps['width']>, string> = {
  sm: 'w-[26rem]',
  md: 'w-[32rem]',
  lg: 'w-[40rem]',
};

export function Drawer({
  open,
  onClose,
  title,
  description,
  width = 'md',
  children,
  footer,
}: DrawerProps): JSX.Element | null {
  // Esc to close + body scroll lock.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
      className="fixed inset-0 z-50"
    >
      {/* Backdrop */}
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-foreground/20 backdrop-blur-md motion-safe:animate-fade-in"
      />

      {/* Panel — anchored to the end edge, floats with soft shadow */}
      <div
        className={cn(
          'absolute inset-y-3 end-3 flex max-w-[100vw] flex-col rounded-2xl bg-card shadow-2xl shadow-foreground/15 ring-1 ring-foreground/[0.06]',
          widthClass[width],
          'motion-safe:animate-slide-in-drawer',
        )}
      >
        {/* Close — floats top-end */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute end-4 top-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground active:scale-[0.94]"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            className="h-4 w-4"
            aria-hidden
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        {/* Header — borderless, generous spacing */}
        <div className="shrink-0 px-8 pt-10 pb-6">
          <div className="min-w-0">
            {typeof title === 'string' ? (
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
                {title}
              </h2>
            ) : (
              title
            )}
            {description && (
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-8 py-2 space-y-6">{children}</div>

        {/* Optional sticky footer — borderless, sits on a faded fade */}
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 px-8 py-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
