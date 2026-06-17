import { useEffect, type RefObject } from 'react';

/*
 * useFocusTrap — keeps keyboard focus inside an open modal/overlay (WCAG 2.4.3).
 *
 * When `active` flips true it:
 *   1. remembers the element that had focus (the trigger),
 *   2. moves focus to the first focusable element inside `containerRef`,
 *   3. traps Tab / Shift+Tab so focus cycles within the container instead of
 *      leaking to the page behind, and
 *   4. on deactivate, restores focus to the trigger.
 *
 * Esc handling is intentionally left to the caller (Drawer/CommandPalette already
 * own it) so this hook stays a single-purpose, composable primitive.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the overlay once it has painted.
    const raf = requestAnimationFrame(() => {
      const focusables = container.querySelectorAll<HTMLElement>(FOCUSABLE);
      (focusables[0] ?? container).focus?.();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [active, containerRef]);
}
