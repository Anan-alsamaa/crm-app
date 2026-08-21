import type { JSX } from 'react';
import { useState } from 'react';
import { cn } from './cn.js';

export interface RefreshButtonProps {
  /**
   * Pull everything on screen again. Resolve when it has finished so the
   * spinner lasts exactly as long as the work does.
   */
  onRefresh: () => Promise<unknown>;
  /** Accessible name, e.g. "Refresh this page". */
  label: string;
  className?: string;
}

function RefreshIcon({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2v3.5H10" />
    </svg>
  );
}

/**
 * The "it's stuck, give me it again" button, in the masthead of every page.
 *
 * It REFETCHES rather than reloading the document, and that is the whole
 * design. A reload throws away the in-memory access token and makes the app
 * restore it from the refresh cookie — a race that, when it loses, lands
 * somebody on the login screen. Pressing refresh should never be able to sign
 * you out. Refetching fixes what "stuck" almost always means (a query that
 * failed, or data that has moved on since the page was opened) in a fraction of
 * the time and without leaving the page you are on.
 *
 * Held busy for a beat past the work finishing. A refetch off a warm cache can
 * return in 40ms, and a spinner that appears and vanishes within one frame
 * reads as a button that did nothing — so people press it again, and again.
 * The floor is feedback, not padding.
 *
 * Lives in the masthead because the masthead is the one thing on every page.
 * Thirty copies of this button would be thirty chances for one of them to be
 * wired to the wrong thing.
 */
export function RefreshButton({ onRefresh, label, className }: RefreshButtonProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return; // a second press during a refresh is the same request
    setBusy(true);
    const started = Date.now();
    try {
      await onRefresh();
    } catch {
      /*
       * Swallowed ON PURPOSE, and it has to be caught somewhere: an async
       * click handler that rejects becomes an unhandled promise rejection,
       * which trips error overlays and logging that suggest something worse
       * than "one request failed".
       *
       * Not swallowed silently in the product sense — a query that fails
       * renders its own error state on the page, which is a better place to
       * say so than a toast over the top of it. The button's only job is to
       * stop spinning and let the person try again.
       */
    } finally {
      const MIN_VISIBLE_MS = 450;
      const elapsed = Date.now() - started;
      if (elapsed < MIN_VISIBLE_MS) {
        await new Promise((r) => setTimeout(r, MIN_VISIBLE_MS - elapsed));
      }
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
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
        'transition-[background-color,color] duration-fast ease-out',
        'hover:bg-ink-foreground/10 hover:text-ink-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
    >
      <span className={cn(busy && 'motion-safe:animate-spin')}>
        <RefreshIcon />
      </span>
    </button>
  );
}
