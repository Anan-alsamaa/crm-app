import type { JSX, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';
import { useFocusTrap } from './useFocusTrap.js';
import { DISMISS_FIRST_ATTR } from './ConfirmDialog.js';

/*
 * A CENTRED modal — for LOOKING AT something, not for filling a form in.
 *
 * `Drawer` is the pattern for "create new X": it keeps the list visible at the
 * side because the list is the context you are working against. But a thing you
 * opened to READ — an order's cart, its tracking — is not a side task, and a
 * side panel on a wide screen puts it in the corner of the eye while the table
 * it came from keeps competing for attention (owner, 2026-09-28: Cart &
 * tracking "should open in center like a popup dialog").
 *
 * Behaviour is the same contract as `Drawer`, deliberately: portal to <body>,
 * focus trap, Esc, backdrop click, body scroll lock. `position: fixed` is only
 * viewport-relative while no ancestor establishes a containing block, and
 * `transform`/`backdrop-filter` both do — the app shell's top bar blurs — so
 * portalling is what makes this correct from any mount point rather than
 * depending on where it is placed.
 *
 * NOT `ConfirmDialog`: that asks a question and owns its buttons. This holds
 * content and leaves the footer to the caller.
 */

interface ModalBase {
  open: boolean;
  onClose: () => void;
  /**
   * Panel width. `md` is the default; `lg`/`xl` are for content with columns
   * or a table in it, which a narrow panel turns into a column of wrapped text.
   */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  children: ReactNode;
  /** Footer actions. Omitted entirely when there are none — see the note. */
  footer?: ReactNode;
  panelClassName?: string;
}

type ModalChrome =
  | { hideChrome?: false; title: ReactNode; description?: ReactNode }
  | { hideChrome: true; title?: ReactNode; description?: ReactNode };

export type ModalProps = ModalBase & ModalChrome;

const sizeClass: Record<NonNullable<ModalBase['size']>, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
};

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  children,
  footer,
  panelClassName,
  hideChrome = false,
}: ModalProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        /* An open popover inside (a quick-reply list) takes this Esc for
           itself — the same rule as ConfirmDialog. */
        if (document.querySelector(`[${DISMISS_FIRST_ATTR}]`)) return;
        e.preventDefault();
        onClose();
      }
    };
    /* Capture phase, so the popover is still in the DOM when this looks. */
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  useFocusTrap(panelRef, open);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
      className="fixed inset-0 z-50"
    >
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-black/55 backdrop-blur-sm motion-safe:animate-fade-in"
      />

      {/*
       * CENTRED, and capped at the viewport.
       *
       * `max-h` with the body scrolling inside is what keeps a long cart from
       * growing the panel past the screen and putting its own close button out
       * of reach — the failure the layout budget note in memory describes.
       * `p-4` is the gutter that keeps it off the edge on a phone.
       */}
      <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-4">
        <div
          ref={panelRef}
          className={cn(
            // NO ring, NO divider lines: the elevation does the separating.
            // Boxed outlines around a panel that already floats read as a
            // 1990s dialog (owner, 2026-09-28).
            'relative flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-3xl shadow-2xl shadow-black/40',
            panelClassName ? panelClassName : 'bg-card',
            sizeClass[size],
            'motion-safe:animate-scale-in',
          )}
        >
          {!hideChrome && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute end-4 top-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground active:scale-[0.94]"
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
          )}

          {/* Header — borderless, like the drawer's. */}
          {!hideChrome && (
            <div className="shrink-0 px-8 pt-8 pb-4 pe-14">
              {typeof title === 'string' ? (
                <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
                  {title}
                </h2>
              ) : (
                title
              )}
              {description && (
                <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
          )}

          <div className={cn('min-h-0 flex-1 overflow-y-auto', hideChrome ? '' : 'px-8 pb-8 pt-2')}>
            {children}
          </div>

          {/*
           * Footer, when there is one. Sits on the panel's own ground with no
           * rule above it — the spacing separates it.
           */}
          {footer && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-8 pb-8 pt-2">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
