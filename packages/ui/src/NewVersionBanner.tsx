import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { cn } from './cn.js';

/**
 * Tells the user when the page they are looking at is out of date.
 *
 * A single-page app never reloads itself. Deploy a new build and anyone with
 * the tab already open keeps running the JavaScript they loaded hours ago —
 * the server is serving the new bundle, and they are not seeing it. That looks
 * exactly like "the change was never made", and it is the reason a fix can be
 * shipped, verified on the server, and still reported as missing.
 *
 * The check needs nothing injected at build time: the document already names
 * the bundle it loaded, so comparing that against the one `index.html` names
 * right now is enough. A mismatch means a newer build is being served.
 */
function currentBundle(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]');
  return el?.getAttribute('src') ?? null;
}

async function servedBundle(): Promise<string | null> {
  // `cache: 'no-store'` so this asks the server, not the browser's copy —
  // otherwise the check itself reads the stale answer it exists to detect.
  const res = await fetch('/index.html', { cache: 'no-store' });
  if (!res.ok) return null;
  const html = await res.text();
  return html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
}

export interface NewVersionBannerProps {
  /** How often to look, in ms. Defaults to five minutes. */
  intervalMs?: number;
  label?: string;
  action?: string;
}

export function NewVersionBanner({
  intervalMs = 5 * 60_000,
  label = 'A newer version of this app is available.',
  action = 'Reload',
}: NewVersionBannerProps): JSX.Element | null {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const mine = currentBundle();
    // In dev there is no hashed bundle to compare, so there is nothing to do.
    if (!mine) return;
    let cancelled = false;
    const check = async () => {
      try {
        const served = await servedBundle();
        if (!cancelled && served && served !== mine) setStale(true);
      } catch {
        // Offline or a blip: say nothing rather than nag.
      }
    };
    const id = setInterval(check, intervalMs);
    // Also check when the tab is brought back, which is when someone returns
    // to a page they left open and is most likely to be looking at old code.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);

  if (!stale) return null;
  return (
    <div
      role="status"
      className={cn(
        'fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit items-center gap-3 rounded-full',
        'bg-ink px-4 py-2.5 text-sm text-ink-foreground shadow-lg ring-1 ring-ink-foreground/15',
      )}
    >
      <span>{label}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-full bg-ink-foreground/15 px-3 py-1 text-xs font-semibold transition-colors duration-fast hover:bg-ink-foreground/25"
      >
        {action}
      </button>
    </div>
  );
}
