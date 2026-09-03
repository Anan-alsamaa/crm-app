/**
 * A standing marker that this is NOT production.
 *
 * Staging carries the real database's shape and, for the widget, the real Yiji
 * tenant — so the expensive mistake is someone believing a staging screen is
 * live and acting on it, or the reverse: dismissing a real production incident
 * as "only staging". The marker therefore has to be impossible to miss and
 * impossible to dismiss.
 *
 * Deliberately NOT a boxed alert. A bordered card reads as a message about the
 * page's content and gets tuned out after a day. This is a thin band pinned to
 * the very top of the viewport, above everything, with a slow travelling sheen
 * — peripheral motion is what keeps it noticeable on the hundredth visit,
 * whereas a static bar becomes invisible.
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

  /* The banner occupies real space at the top of the document. Rather than ask
   * every app to add padding — which they would forget, and which would then
   * hide their own headers behind this one — it sets the offset itself and
   * removes it on unmount. */
  useEffect(() => {
    if (!show) return;
    const root = document.documentElement;
    const prev = root.style.getPropertyValue('--env-banner-height');
    root.style.setProperty('--env-banner-height', '28px');
    document.body.style.paddingTop = '28px';
    return () => {
      root.style.setProperty('--env-banner-height', prev);
      document.body.style.paddingTop = '';
    };
  }, [show]);

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
          insetInlineStart: 0,
          insetInlineEnd: 0,
          top: 0,
          zIndex: 2147483647, // above dialogs, drawers and command palettes
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '.55rem',
          // A warm red that reads as "caution", not "error" — nothing is broken.
          background: 'linear-gradient(90deg,#B3261E 0%,#D93A2B 50%,#B3261E 100%)',
          color: '#fff',
          font: '600 11.5px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
          letterSpacing: '.12em',
          textTransform: 'uppercase',
          boxShadow: '0 1px 6px rgba(0,0,0,.28)',
          overflow: 'hidden',
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
          {label} — not live data
          {detail ? ` · ${detail}` : ''}
        </span>
      </div>
    </>
  );
}
