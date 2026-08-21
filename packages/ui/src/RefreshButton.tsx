import type { JSX } from 'react';
import { useState } from 'react';
import { cn } from './cn.js';

export interface RefreshButtonProps {
  /**
   * Reload the page. Normally never resolves — the document is replaced — so
   * the button stays in its busy state until it goes away.
   */
  onRefresh: () => Promise<unknown> | void;
  /** The word on the button, and its accessible name. */
  label: string;
  /** Shown while the reload is in flight. */
  busyLabel?: string;
  className?: string;
}

/**
 * The "it's stuck, give me it again" button, in the masthead of every page.
 *
 * It does a REAL page reload. An earlier version refetched the React Query
 * cache instead, on the reasoning that a reload drops the in-memory access
 * token and has to restore it from the refresh cookie. That reasoning was
 * wrong in the way that matters: pressing F5 does exactly the same thing, so
 * the risk was never specific to this button — and a "refresh" that visibly
 * leaves the page untouched is not the thing anyone means when they say the
 * page is stuck. A refetch cannot fix a wedged component, a bad route, or a
 * stale bundle; a reload fixes all three, which is the entire reason the
 * button exists.
 *
 * The word rather than a glyph. A circular arrow is read as "retry this
 * widget" as often as "reload everything", and this button is drastic enough
 * that it should say what it does.
 *
 * Lives in the masthead because the masthead is the one thing on every page.
 * Thirty copies of this button would be thirty chances for one to be wired to
 * the wrong thing.
 */
export function RefreshButton({
  onRefresh,
  label,
  busyLabel,
  className,
}: RefreshButtonProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return; // a second press during a reload is the same request
    setBusy(true);
    try {
      await onRefresh();
    } catch {
      /*
       * Swallowed on purpose: an async click handler that rejects becomes an
       * unhandled promise rejection, which trips error overlays suggesting
       * something worse than "the reload did not start". Releasing `busy`
       * below lets the person simply press it again.
       */
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={run}
      // Not `disabled`: a disabled control loses focus and stops announcing
      // itself, so a keyboard user is dropped mid-action. `aria-busy` says the
      // same thing without taking the button away.
      aria-busy={busy}
      title={label}
      className={cn(
        // Tight on purpose. This sits in the masthead next to the primary
        // nav, and the word at comfortable padding took enough width to start
        // truncating nav items on a 1440px screen.
        'inline-flex h-8 shrink-0 items-center rounded-full px-2',
        'text-2xs font-semibold uppercase tracking-[0.04em]',
        'transition-[background-color,color] duration-fast ease-out',
        'hover:bg-ink-foreground/10 hover:text-ink-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
    >
      {busy ? (busyLabel ?? label) : label}
    </button>
  );
}
