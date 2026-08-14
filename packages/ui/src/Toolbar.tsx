import type { HTMLAttributes, JSX } from 'react';
import { cn } from './cn.js';

/**
 * Sticky toolbar surface used at the top of list/detail panes. Reads as the
 * page-header band of the reference boards: no full-width card fill — a
 * canvas-toned blur keeps it legible when rows scroll beneath — with roomier
 * height and a bolder title slot.
 */
export function Toolbar({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        'sticky top-0 z-20 flex h-16 items-center gap-3 bg-background/60 px-4 backdrop-blur sm:px-6',
        // Pages pass a small h1 as the title slot; promote it to a band label
        // (the compound selector outranks the page-level text-sm). text-lg,
        // not display size: report/list pages carry their OWN big in-body
        // title, and two stacked display titles read as a rendering bug.
        '[&>h1]:text-lg [&>h1]:font-bold [&>h1]:tracking-tight',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function ToolbarSpacer(): JSX.Element {
  return <span className="flex-1" aria-hidden />;
}
