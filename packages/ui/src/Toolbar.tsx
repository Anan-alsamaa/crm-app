import type { HTMLAttributes, JSX } from 'react';
import { cn } from './cn.js';

/**
 * Sticky toolbar surface used at the top of list/detail panes. Sits flush with
 * the page header so the toolbar reads as part of the same chrome.
 */
export function Toolbar({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        'sticky top-0 z-20 flex h-14 items-center gap-3 bg-card/60 px-4 backdrop-blur sm:px-6',
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
