import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button.js';

/*
 * Accessible confirmation dialog — a replacement for the native, unstyled,
 * un-trappable window.confirm(). Used for destructive actions (delete a user,
 * a rule, a field, a report) where we want a clear, reversible-feeling prompt.
 *
 * Mirrors CreateTicketDialog's overlay (bg-black/55 backdrop-blur-sm,
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
  /**
   * Disable the confirm button because the form is INCOMPLETE — distinct from
   * `loading`, which means "busy".
   *
   * Without this a dialog with a required field has nowhere to express it, and
   * the only options were to let the press commit a bad record or to silently
   * swallow it — which reads as a dead button, the single most-reported shape
   * in this codebase. Pair it with `confirmHint` so the button says WHY.
   */
  confirmDisabled?: boolean;
  /** Shown beside the buttons when `confirmDisabled` — what is still missing. */
  confirmHint?: string;
  /** Invoked when the user confirms. */
  onConfirm: () => void;
  /** Invoked when the user cancels (button, Esc, or backdrop click). */
  onCancel: () => void;
  /**
   * Whether a click on the backdrop cancels. Defaults to true.
   *
   * False for a dialog holding work that is expensive to lose — the ticket
   * import, where a stray click threw away a chosen file and its preview
   * (owner, 2026-10-05). Cancel and Esc still close it.
   */
  dismissOnBackdrop?: boolean;
}

/**
 * MARKS A NESTED POPOVER THAT ABSORBS THE FIRST DISMISS.
 *
 * A suggestion list open inside the dialog (the quick replies on a late-order
 * decision) must close on the first outside click or Esc, and only a SECOND
 * one may close the dialog (owner, 2026-10-05). Before, one click threw away
 * the whole half-written decision when the agent only meant to put the list
 * away. Any element carrying this attribute, while it is in the panel, makes
 * the dialog stand still for that press.
 */
export const DISMISS_FIRST_ATTR = 'data-dismiss-first';

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
  confirmDisabled = false,
  confirmHint,
  onConfirm,
  onCancel,
  dismissOnBackdrop = true,
}: ConfirmDialogProps): JSX.Element | null {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  /*
   * WHERE THE PRESS STARTED, decided at pointerdown.
   *
   * A `click` lands on the nearest common ancestor of press and release, so a
   * drag that started INSIDE the panel (selecting text, nudging a slider) and
   * ended over the backdrop arrived here as a backdrop click and closed the
   * dialog (owner, 2026-10-05: "if I drag and go out of the popup, it
   * closes"). Only a press that both starts and ends on the backdrop counts.
   */
  const backdropPress = useRef(false);
  const nestedPopoverOpen = () => !!panelRef.current?.querySelector(`[${DISMISS_FIRST_ATTR}]`);

  // Move focus to the primary action when the dialog opens.
  useEffect(() => {
    if (open) requestAnimationFrame(() => confirmRef.current?.focus());
  }, [open]);

  // Esc cancels even when focus is on a non-button element inside the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        /* An open popover inside takes this Esc for itself. */
        if (nestedPopoverOpen()) return;
        e.preventDefault();
        onCancel();
      }
    };
    /* CAPTURE phase, so this sees an open popover before the popover's own
       Esc handler removes it — otherwise one Esc would close both. */
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  // Portalled to <body>: `position: fixed` is only viewport-relative while no
  // ancestor establishes a containing block, and transform/filter/backdrop-filter/
  // perspective/will-change/contain all create one. The app shell's top bar is
  // backdrop-blurred, so an overlay opened from there would otherwise anchor to it.
  if (!open || typeof document === 'undefined') return null;

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

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm animate-fade-in"
      onPointerDown={(e) => {
        /* Read BEFORE the popover's own outside-press handler re-renders it
           away, so a press that closes the list does not also close this. */
        backdropPress.current = e.target === e.currentTarget && !nestedPopoverOpen();
      }}
      onClick={(e) => {
        const armed = backdropPress.current;
        backdropPress.current = false;
        if (dismissOnBackdrop && armed && e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        onKeyDown={onPanelKey}
        className="w-full max-w-sm rounded-2xl bg-card p-7 shadow-xl shadow-black/30 ring-1 ring-border animate-scale-in"
      >
        <div className="mb-6 space-y-1.5">
          <h3
            id={titleId}
            className="font-display text-xl font-bold tracking-tight text-foreground"
          >
            {title}
          </h3>
          {description && (
            <p id={descId} className="text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          {/* WHY the button is dead, where the eye already is. A disabled
              control cannot explain itself, and "nothing happens" is how every
              one of these has been reported. */}
          {confirmDisabled && confirmHint && (
            <p className="me-auto text-2xs leading-snug text-muted-foreground">{confirmHint}</p>
          )}
          <Button type="button" variant="ghost" size="md" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            size="md"
            variant={destructive ? 'destructive' : 'default'}
            loading={loading}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
