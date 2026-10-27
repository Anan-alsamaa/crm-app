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
  /**
   * Reload on its own once a newer build is served (default on). Without it a
   * fix reaches only those who click Reload: on 2026-10-27 tabs left open - the
   * TV screen above all - kept running a build that loaded every ticket, long
   * after the fix was released.
   */
  autoReload?: boolean;
  /** No keyboard/pointer input for this long counts as idle. Default 5 min. */
  idleMs?: number;
}

/**
 * Text the person has typed and not sent: any non-empty textarea or
 * contenteditable, or the focused text input. A reload would lose it, so the
 * automatic reload waits while there is any.
 */
export function hasUnsavedText(doc: Document = document): boolean {
  for (const el of Array.from(doc.querySelectorAll('textarea'))) {
    if ((el as HTMLTextAreaElement).value.trim()) return true;
  }
  for (const el of Array.from(doc.querySelectorAll('[contenteditable="true"]'))) {
    if ((el.textContent ?? '').trim()) return true;
  }
  const active = doc.activeElement as HTMLInputElement | null;
  if (active && active.tagName === 'INPUT' && active.value && active.value.trim()) return true;
  return false;
}

export function NewVersionBanner({
  intervalMs = 5 * 60_000,
  label = 'A newer version of this app is available.',
  action = 'Reload',
  autoReload = true,
  idleMs = 5 * 60_000,
}: NewVersionBannerProps): JSX.Element | null {
  const [stale, setStale] = useState(false);

  /*
   * THE SAFE AUTOMATIC RELOAD.
   *   - A tab in the background reloads at once: nobody is looking at it.
   *   - A tab on screen (the TV) reloads after `idleMs` with no input.
   *   - Never while there is typed, unsent text (hasUnsavedText) - it waits.
   * The strip below stays, so anyone can update at once.
   */
  useEffect(() => {
    if (!stale || !autoReload) return;
    let lastInput = Date.now();
    const touch = () => {
      lastInput = Date.now();
    };
    const tryReload = (force: boolean) => {
      if (hasUnsavedText()) return;
      if (force || Date.now() - lastInput >= idleMs) window.location.reload();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') tryReload(true);
    };
    if (document.visibilityState === 'hidden') tryReload(true);
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    const id = setInterval(() => tryReload(false), 30_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(id);
    };
  }, [stale, autoReload, idleMs]);

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
      data-version-banner=""
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
