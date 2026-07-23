import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import { Button } from './Button.js';

/*
 * Accessible confirmation dialog — a replacement for the native, unstyled,
 * un-trappable window.confirm(). Used for destructive actions (delete a user,
 * a rule, a field, a report) where we want a clear, reversible-feeling prompt.
 *
 * Mirrors CreateTicketDialog's overlay (bg-black/55 backdrop-blur-md,
 * animate-fade-in / animate-scale-in) so it sits naturally alongside the rest
 * of the app's modals. Accessibility:
 *   - role="alertdialog" + aria-modal, labelled by the title (+ described by
 *     the description when present)
 *   - focus moves to the default action on open and is trapped within the
 *     dialog while Tab/Shift+Tab cycle
 *   - Esc and backdrop click both cancel
 *
 * Presentation only and dependency-free — the caller owns open state and the
 * actual mutation that runs on confirm.
 */

export interface ConfirmDialogProps {
  /** Whether the dialog is shown. */
  open: boolean;
  /** Short, action-oriented heading (e.g. "Delete this account?"). */
  title: string;
  /** Optional supporting copy explaining the consequence. */
  description?: ReactNode;
  /** Label for the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Render the confirm button with the destructive variant. */
  destructive?: boolean;
  /** Disable the confirm button + show a spinner while the action runs. */
  loading?: boolean;
  /** Invoked when the user confirms. */
  onConfirm: () => void;
  /** Invoked when the user cancels (button, Esc, or backdrop click). */
  onCancel: () => void;
}

/** Elements that can receive keyboard focus, for the Tab trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Move focus to the primary action when the dialog opens.
  useEffect(() => {
    if (open) requestAnimationFrame(() => confirmRef.current?.focus());
  }, [open]);

  // Esc cancels even when focus is on a non-button element inside the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  // Trap Tab within the panel so focus never leaks to the page behind it.
  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null,
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panelRef.current.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-md animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        onKeyDown={onPanelKey}
        className="w-full max-w-sm rounded-3xl bg-card p-7 shadow-2xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in"
      >
        <div className="mb-6 space-y-1.5">
          <h3 id={titleId} className="text-xl font-semibold tracking-[-0.02em] text-foreground">
            {title}
          </h3>
          {description && (
            <p id={descId} className="text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="md" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            size="md"
            variant={destructive ? 'destructive' : 'default'}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
