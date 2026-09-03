/**
 * A standing marker that this is NOT production.
 *
 * Staging carries the real database's shape and, for the widget, the real Yiji
 * tenant — so the expensive mistake is someone believing a staging screen is
 * live and acting on it, or the reverse: dismissing a real production incident
 * as "only staging". The marker therefore has to be impossible to miss and
 * impossible to dismiss.
 *
 * A small pill centred at the top of the viewport rather than a full-width
 * band: it stays out of the layout entirely, so no page has to reserve space
 * for it and nothing shifts when it appears. The slow travelling sheen is what
 * keeps it noticeable on the hundredth visit — a static badge becomes
 * wallpaper within a day.
 *
 * Renders NOTHING when the environment is production or unset, so it costs
 * production a few bytes and no layout.
 */
import { useEffect, useState } from 'react';

export interface EnvironmentBannerProps {
  /** Environment name, e.g. 'staging'. Absent/'production' renders nothing. */
  environment?: string;
  /** Optional extra context, e.g. 'coupon delivery is off'. */
  detail?: string;
}

/** Environments that are NOT production and therefore need the marker. */
const NON_PRODUCTION = new Set(['staging', 'stg', 'test', 'dev', 'development', 'preview']);

export function EnvironmentBanner({ environment, detail }: EnvironmentBannerProps) {
  const env = environment?.trim().toLowerCase();
  const show = !!env && NON_PRODUCTION.has(env);

  /* No body offset. A full-width band has to push the page down; a floating
   * pill overlays it, so nothing reflows and no app has to know it exists. */

  // Respect the OS "reduce motion" setting: the sheen is decoration, and for
  // anyone who finds movement uncomfortable it is worse than useless.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    setReduceMotion(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  if (!show) return null;

  const label = env === 'staging' ? 'STAGING' : env!.toUpperCase();

  return (
    <>
      <style>{`
        @keyframes crm-env-sheen {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(220%); }
        }
        @keyframes crm-env-pulse {
          0%, 100% { opacity: .92; }
          50%      { opacity: 1; }
        }
      `}</style>
      <div
        role="status"
        aria-live="polite"
        data-env-banner={env}
        style={{
          position: 'fixed',
          top: 8,
          // Centred without needing a width: the pill is only as wide as its
          // text, so it never crowds the app's own header.
          insetInlineStart: '50%',
          transform: 'translateX(-50%)',
          zIndex: 2147483647, // above dialogs, drawers and command palettes
          display: 'inline-flex',
          alignItems: 'center',
          gap: '.45rem',
          padding: '5px 12px 5px 10px',
          borderRadius: 999,
          // A warm red that reads as "caution", not "error" — nothing is broken.
          background: 'linear-gradient(90deg,#B3261E 0%,#D93A2B 50%,#B3261E 100%)',
          color: '#fff',
          font: '600 11px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          // A ring rather than a heavy shadow, so it reads as a badge sitting
          // ON the page rather than a bar attached to the window.
          boxShadow: '0 2px 10px rgba(0,0,0,.22), 0 0 0 1px rgba(255,255,255,.35) inset',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          userSelect: 'none',
          pointerEvents: 'none', // never intercepts a click meant for the app
          animation: reduceMotion ? undefined : 'crm-env-pulse 4s ease-in-out infinite',
        }}
      >
        {/* Travelling sheen — the peripheral movement that stops this becoming
            wallpaper. Purely decorative, so hidden from assistive tech. */}
        {!reduceMotion && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              insetBlock: 0,
              insetInlineStart: 0,
              width: '28%',
              background:
                'linear-gradient(90deg,transparent 0%,rgba(255,255,255,.30) 50%,transparent 100%)',
              animation: 'crm-env-sheen 5.5s linear infinite',
            }}
          />
        )}
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 0 0 3px rgba(255,255,255,.28)',
            flex: 'none',
          }}
        />
        <span style={{ position: 'relative' }}>
          {label}
          {detail ? ` · ${detail}` : ''}
        </span>
      </div>
    </>
  );
}
