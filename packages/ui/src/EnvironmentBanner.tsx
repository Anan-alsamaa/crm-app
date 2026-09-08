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
import { createPortal } from 'react-dom';

export interface EnvironmentBannerProps {
  /** Environment name, e.g. 'staging'. Absent/'production' renders nothing. */
  environment?: string;
  /**
   * The sentence after the environment name. Defaults to a plain statement
   * that the data is not live — which is the thing someone needs to know
   * before they act on what is on screen. Override for anything more
   * specific, e.g. 'coupon delivery is off'.
   */
  detail?: string;
}

/** Environments that are NOT production and therefore need the marker. */
const NON_PRODUCTION = new Set(['staging', 'stg', 'test', 'dev', 'development', 'preview']);

export function EnvironmentBanner({ environment, detail }: EnvironmentBannerProps) {
  const env = environment?.trim().toLowerCase();
  const show = !!env && NON_PRODUCTION.has(env);

  /*
   * IT RESERVES ITS OWN STRIP.
   *
   * The original note here read: "a floating pill overlays the page, so
   * nothing reflows and no app has to know it exists." That is true and it is
   * exactly why the badge covered the navigation — the portals centre their
   * nav, the badge centred itself, and an overlay that reflows nothing lands
   * on whatever was already there.
   *
   * So it pushes the page down by its own height instead. Costs one strip of
   * vertical space in non-production only, and buys top-centre placement that
   * hides nothing at any width.
   */
  /*
   * Find the app's own top bar and render INTO it.
   *
   * Every previous position was a compromise between two bad options: float
   * over the bar and cover the navigation, or reserve a strip above it and
   * spend vertical space. A slot inside the bar has neither cost — the nav is
   * a flex child, so it simply shrinks by the badge's width.
   *
   * OBSERVED, not polled. This mounts at the app root, long before the shell
   * renders its header — and on the login screen there is no header at all,
   * so any bounded wait expires while the user is still typing their
   * password. A first attempt at this used ~2s of animation frames and always
   * fell back to floating, because signing in takes longer than that.
   *
   * The observer keeps watching, so the badge moves into the bar the moment
   * one exists, and back out if it ever goes away. Until then it floats, so
   * the warning is never simply absent.
   */
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!show) return;
    const find = () =>
      setSlot(document.querySelector<HTMLElement>('[data-app-topbar] [data-env-slot]'));
    find();
    const mo = new MutationObserver(find);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
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

  const banner = (
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
        /* On a phone the strip is scarce; the environment name alone carries
           the warning there. */
        @media (max-width: 640px) {
          [data-env-banner] .crm-env-detail { display: none; }
        }
      `}</style>
      <div
        role="status"
        aria-live="polite"
        data-env-banner={env}
        style={{
          // In the bar: a normal flex child, so the nav shrinks around it.
          // Floating only when no bar was found — see the fallback below.
          ...(slot
            ? { position: 'relative' }
            : {
                position: 'fixed' as const,
                top: 12,
                insetInlineEnd: 16,
              }),
          zIndex: 2147483647, // above dialogs, drawers and command palettes
          display: 'inline-flex',
          alignItems: 'center',
          gap: '.4rem',
          // Small enough to sit BESIDE the navigation rather than over it.
          // It was a full sentence in a pill wide enough to cover three nav
          // items — a warning that hides the app is a worse warning, because
          // the first thing anyone does is look for how to dismiss it.
          padding: '5px 12px 5px 9px',
          borderRadius: 999,
          // A warm red that reads as "caution", not "error" — nothing is broken.
          background: 'linear-gradient(90deg,#B3261E 0%,#D93A2B 50%,#B3261E 100%)',
          color: '#fff',
          font: '600 10px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
          letterSpacing: '.04em',
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
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 0 0 3px rgba(255,255,255,.28)',
            flex: 'none',
          }}
        />
        <span
          style={{
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: '.5rem',
          }}
        >
          <strong style={{ fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase' }}>
            {label}
          </strong>
          {/* "STAGING" carries the warning; this explains it. Kept short — the
              badge sits in a corner, not across the top, and a long sentence
              there is a wide rectangle over whatever the page put in its own
              bottom corner. */}
          <span
            className="crm-env-detail"
            style={{ opacity: 0.92, fontWeight: 500, letterSpacing: '.02em' }}
          >
            {detail ?? 'data is not live'}
          </span>
        </span>
      </div>
    </>
  );

  // Into the app bar when there is one; a floating badge otherwise, so the
  // warning survives on screens that have no bar at all (the login page).
  return slot ? createPortal(banner, slot) : banner;
}
