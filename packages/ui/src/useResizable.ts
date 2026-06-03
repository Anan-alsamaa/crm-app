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
}

/**
 * Drag-to-resize hook for a panel anchored to the start edge.
 * Returns the current width plus a `bind` for the drag handle.
 */
export function useResizable({ storageKey, defaultWidth, min, max }: Options) {
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

      const onMove = (ev: PointerEvent) => {
        const delta = isRTL ? startX - ev.clientX : ev.clientX - startX;
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
    [width, min, max],
  );

  return { width, setWidth, dragging, bind: { onPointerDown } };
}
