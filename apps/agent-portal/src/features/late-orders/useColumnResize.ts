import { useCallback, useRef, useState, type RefObject } from 'react';
import {
  clampColumnWidth,
  loadLateOrderColumnWidths,
  saveLateOrderColumnWidths,
  type LateOrderColumnKey,
  type LateOrderColumnWidths,
} from './columns.js';

/**
 * DRAG A COLUMN'S RIGHT EDGE TO RESIZE IT (owner, 2026-10-11).
 *
 * Until the first drag the table keeps its natural (auto) widths. The first
 * drag MEASURES every visible header and switches the table to fixed widths,
 * so a column can be made narrower than its content as well as wider. Saved in
 * this browser; a double-click on any handle returns to the natural widths.
 */
export function useColumnResize(
  visible: readonly LateOrderColumnKey[],
  /** The table's `<thead>`; its first row's cells are measured. */
  headerRow: RefObject<HTMLTableSectionElement | null>,
) {
  const [widths, setWidths] = useState<LateOrderColumnWidths | null>(() =>
    loadLateOrderColumnWidths(),
  );
  const [dragging, setDragging] = useState<LateOrderColumnKey | null>(null);
  const latest = useRef(widths);
  latest.current = widths;

  const measure = useCallback((): LateOrderColumnWidths => {
    const out: LateOrderColumnWidths = { ...(latest.current ?? {}) };
    const cells = headerRow.current?.rows[0]?.children;
    visible.forEach((k, i) => {
      const el = cells?.[i] as HTMLElement | undefined;
      if (out[k] == null && el) out[k] = clampColumnWidth(el.getBoundingClientRect().width);
    });
    return out;
  }, [visible, headerRow]);

  const start = useCallback(
    (key: LateOrderColumnKey, e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const base = measure();
      const startX = e.clientX;
      const startW = base[key] ?? 120;
      // In a right-to-left page the right edge moves the other way.
      const dir = getComputedStyle(e.currentTarget).direction === 'rtl' ? -1 : 1;
      setWidths(base);
      setDragging(key);
      const move = (ev: PointerEvent) => {
        const next = { ...base, [key]: clampColumnWidth(startW + dir * (ev.clientX - startX)) };
        latest.current = next;
        setWidths(next);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setDragging(null);
        saveLateOrderColumnWidths(latest.current);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [measure],
  );

  const reset = useCallback(() => {
    setWidths(null);
    saveLateOrderColumnWidths(null);
  }, []);

  return { widths, dragging, start, reset };
}
