import { useEffect, useRef, type RefObject } from 'react';

/**
 * CLOSE A PANEL ON A PRESS OUTSIDE IT, OR ON ESCAPE (owner, 2026-10-25).
 *
 * One hook for every composer panel (AI assistance, the Enhance suggestion,
 * quick replies), because each had grown its own rule - or none: the AI panel
 * only closed from its own button, so an agent who opened it to look and then
 * went back to the thread was left with it covering the composer.
 *
 *  - `pointerdown`, not `click`: a press that starts outside dismisses even if
 *    the pointer travels before release, which is how a real mis-click behaves.
 *  - `refs` are the INSIDE: the panel AND its own trigger. Leaving the trigger
 *    out would close the panel on pointerdown and reopen it on the click that
 *    follows, so the button could never toggle it shut.
 *  - Nothing is prevented: the press still lands where it was aimed, so a press
 *    into the composer closes a panel and puts the caret in the box with the
 *    draft untouched.
 *
 * Only listens while `open`. `onDismiss` may change every render; the latest
 * one is called.
 */
export function useDismissOnOutside(
  open: boolean,
  onDismiss: (e: PointerEvent | KeyboardEvent) => void,
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
): void {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const inside = useRef(refs);
  inside.current = refs;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (inside.current.some((r) => r.current?.contains(target))) return;
      dismiss.current(e);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss.current(e);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
}
