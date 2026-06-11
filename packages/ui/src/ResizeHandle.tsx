import type { JSX, PointerEvent } from 'react';
import { cn } from './cn.js';

export interface ResizeHandleProps {
  /** Spread from `useResizable().bind`. */
  bind: { onPointerDown: (e: PointerEvent<HTMLElement>) => void };
  dragging: boolean;
  /**
   * The panel's anchor edge — same value passed to `useResizable`. The handle
   * is rendered on the opposite (free) edge: a `start`-anchored panel gets its
   * handle on the trailing edge, an `end`-anchored panel on the leading edge.
   */
  side: 'start' | 'end';
  /** Accessible label. */
  label: string;
}

/**
 * A thin drag affordance on a panel edge. Pairs with `useResizable`. The hit
 * area is wider than the visible 2px line so it's easy to grab; the line lights
 * up on hover/drag.
 */
export function ResizeHandle({ bind, dragging, side, label }: ResizeHandleProps): JSX.Element {
  return (
    <div
      {...bind}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className={cn(
        'group/handle absolute inset-y-0 z-10 flex w-2 cursor-col-resize items-center justify-center',
        side === 'start' ? 'end-0 -me-1' : 'start-0 -ms-1',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-10 w-0.5 rounded-full transition-colors duration-fast ease-out',
          dragging ? 'bg-primary' : 'bg-transparent group-hover/handle:bg-primary/40',
        )}
      />
    </div>
  );
}
