import { useCallback, useEffect, useState } from 'react';

interface Options {
  /** localStorage key for persistence. */
  storageKey: string;
  /** Default width if nothing stored. */
  defaultWidth: number;
  /** Minimum width during drag. */
  min: number;
  /** Maximum width during drag. */
  max: number;
  /**
   * Which edge the panel is anchored to. `'start'` (default) puts the drag
   * handle on the trailing edge and grows the panel as you drag outward (used
   * by the side rail and the inbox list). `'end'` anchors the panel to the
   * trailing edge with the handle on the leading edge (the conversation
   * details panel) — the drag direction is inverted accordingly.
   */
  side?: 'start' | 'end';
}

/**
 * Drag-to-resize hook. Returns the current width plus a `bind` for the drag
 * handle. RTL-aware, and edge-aware via `side`.
 */
export function useResizable({ storageKey, defaultWidth, min, max, side = 'start' }: Options) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
    return defaultWidth;
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      const isRTL = document.documentElement.dir === 'rtl';
      setDragging(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const sign = (isRTL ? -1 : 1) * (side === 'end' ? -1 : 1);
      const onMove = (ev: PointerEvent) => {
        const delta = sign * (ev.clientX - startX);
        const next = Math.max(min, Math.min(max, startWidth + delta));
        setWidth(next);
      };
      const onUp = () => {
        setDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [width, min, max, side],
  );

  return { width, setWidth, dragging, bind: { onPointerDown } };
}
