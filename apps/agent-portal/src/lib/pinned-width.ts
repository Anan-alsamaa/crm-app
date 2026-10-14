import { useMemo, useRef } from 'react';

/** A callback ref that ALSO reads like a RefObject (`.current`), so the
 *  components that take the scrollport as a RefObject keep working. */
export type PinnedRef<T> = ((el: T | null) => void) & { current: T | null };

/**
 * Publishes the scrollport's own width as `--pin-w`, for blocks that must stay
 * put while the page scrolls sideways.
 *
 * WHY A MEASUREMENT AND NOT JUST `sticky start-0`.
 *
 * A report in flow mode lets the PAGE scroll horizontally, so the table can
 * reach its far columns and the scrollbar lands at the foot of the screen
 * rather than under the last row. Everything else on the page rides along with
 * it: scroll right to read "Response" and the filter bar you were using has
 * slid out of the window behind you.
 *
 * `position: sticky` is the obvious answer and does nothing on its own here.
 * A sticky element can never leave its CONTAINING BLOCK, and the report's
 * content stack is exactly as wide as the viewport — so at any scroll position
 * past zero the whole containing block is off-screen and sticky has nowhere to
 * hold the child. The stack has to be `w-max min-w-full` (as wide as its widest
 * child, the table) before sticking means anything.
 *
 * That fixes the room and creates the second problem: a block child of a
 * `w-max` stack is laid out at the STACK's width, so the filter bar would
 * stretch to the width of the table. `w-full` cannot help — it resolves against
 * the same stack. There is no CSS keyword for "as wide as my scrollport", so
 * the width is measured and handed down as a variable, and the pinned blocks
 * take `w-[var(--pin-w,100%)]`. The fallback keeps them full-width anywhere the
 * variable is absent, which is every page that does not scroll sideways.
 */
export function usePinnedWidth<T extends HTMLElement = HTMLDivElement>() {
  /*
   * A CALLBACK REF, not useRef + a mount effect (2026-10-14). The effect ran
   * once, at mount - and a page that shows a loading state first mounts its
   * scrollport LATER, so the effect saw null and never measured. The Late
   * orders report did exactly that: --pin-w was never set, the pinned filter
   * bar took the table's width, and the date fields sat off to the right.
   * A callback ref runs whenever the scrollport is attached or replaced.
   */
  const cleanup = useRef<(() => void) | null>(null);

  return useMemo(() => {
    const ref = ((el: T | null) => {
      ref.current = el;
      cleanup.current?.();
      cleanup.current = null;
      if (!el || typeof window === 'undefined') return;

      const measure = () => {
        // clientWidth EXCLUDES the vertical scrollbar but INCLUDES the
        // scrollport's own padding, and the pinned blocks sit inside that
        // padding — so the padding has to come off, or every one of them
        // overhangs the right edge by exactly the gutter.
        const cs = getComputedStyle(el);
        const pad = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
        const w = el.clientWidth - pad;
        if (w > 0) el.style.setProperty('--pin-w', `${w}px`);
      };

      measure();
      window.addEventListener('resize', measure);
      let ro: ResizeObserver | undefined;
      // Guarded: this is an enhancement, and an environment without
      // ResizeObserver (jsdom) must still render the report.
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(measure);
        ro.observe(el);
      }
      cleanup.current = () => {
        window.removeEventListener('resize', measure);
        ro?.disconnect();
      };
    }) as PinnedRef<T>;
    ref.current = null;
    return ref;
  }, []);
}

/**
 * The classes a block needs to stay put while the page scrolls sideways.
 *
 * Kept as one string so the five places that use it cannot drift apart — the
 * width and the stickiness only work as a pair, and half of it applied alone
 * is the silent no-op this whole file exists to explain.
 */
export const PINNED = 'sticky start-0 w-[var(--pin-w,100%)]';
