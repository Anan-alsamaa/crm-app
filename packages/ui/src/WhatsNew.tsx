import type { CSSProperties, JSX, ReactNode, Ref } from 'react';
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';
import { useFocusTrap } from './useFocusTrap.js';
import { useMediaQuery } from './useMediaQuery.js';
import {
  WHATS_NEW_STYLES,
  WhatsNewArt,
  WhatsNewConfetti,
  WhatsNewHeroBackdrop,
  type WhatsNewArtKind,
} from './WhatsNewArt.js';

/*
 * WHAT'S NEW (owner, 2026-10-25) — a short tour of what changed in a release,
 * shown once per person per version and reopened from the help panel.
 *
 * Opt-in: nothing in this package renders it unless a portal mounts a
 * `WhatsNewProvider`. The portal owns WHO sees it (its roles) and WHAT they
 * read (its own typed notes file); this file owns how it looks, when it may
 * appear, and the "seen" memory.
 */

export interface WhatsNewSlide {
  title: string;
  body: string;
  /** The places in the product the slide is about. */
  tags?: readonly string[];
  /** The small animated picture drawn beside it. */
  art?: WhatsNewArtKind;
}

/** The last step: a thank-you, with a little celebration. */
export interface WhatsNewOutro {
  title: string;
  body: string;
}

export interface WhatsNewCopy {
  headline: string;
  sub: string;
  /** Who this tour is written for, e.g. "For WeCare Agents". */
  audienceLabel?: string;
  slides: readonly WhatsNewSlide[];
  /** An extra closing step after the slides, with the final call to action. */
  outro?: WhatsNewOutro;
}

export interface WhatsNewLocalized {
  en: WhatsNewCopy;
  ar: WhatsNewCopy;
}

/** One release's notes, per audience. An absent audience sees nothing. */
export interface WhatsNewRelease<A extends string = string> {
  version: string;
  audiences: Partial<Record<A, WhatsNewLocalized>>;
}

/** The copy for this audience in this language, or null when there is none. */
export function whatsNewCopy<A extends string>(
  release: WhatsNewRelease<A>,
  audience: A | null | undefined,
  locale: string | null | undefined,
): WhatsNewCopy | null {
  if (!audience) return null;
  const entry = release.audiences[audience];
  if (!entry) return null;
  const copy = String(locale ?? '').startsWith('ar') ? entry.ar : entry.en;
  return copy && copy.slides.length > 0 ? copy : null;
}

/* ── "Seen" memory ─────────────────────────────────────────────────────────
 *
 * Per user, per portal, the last version they closed. A newer version reads
 * as unseen on its own, so nothing ever needs clearing.
 *
 * In the browser, not on the server: the only per-user field a person may
 * write themselves (`directus_users.notification_preferences`) is rewritten
 * whole by the Preferences page, which would erase this and bring the tour
 * back. A new field would be schema, which this feature does not add.
 */
const KEY_PREFIX = 'sara.whatsNew';

export function whatsNewStorageKey(portal: string, userId: string): string {
  return `${KEY_PREFIX}.${portal}.${userId}`;
}

export function hasSeenWhatsNew(portal: string, userId: string, version: string): boolean {
  try {
    return localStorage.getItem(whatsNewStorageKey(portal, userId)) === version;
  } catch {
    // No storage at all (blocked site data): showing it on every page load
    // would be worse than not showing it.
    return true;
  }
}

export function markWhatsNewSeen(portal: string, userId: string, version: string): void {
  try {
    localStorage.setItem(whatsNewStorageKey(portal, userId), version);
  } catch {
    /* storage unavailable — nothing to remember with */
  }
}

/**
 * Another modal is up (a drawer, a confirm, the command palette) or a new-chat
 * alert is asking for attention. The tour waits rather than stacking on top.
 */
function otherModalOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector(
    '[role="dialog"][aria-modal="true"]:not([data-whats-new]), [role="alertdialog"]',
  );
}

/* ── The dialog ─────────────────────────────────────────────────────────── */

export interface WhatsNewLabels {
  /** The header badge, e.g. "New in v1.2.1". */
  badge: string;
  /** "2 of 4". */
  step: (current: number, total: number) => string;
  next: string;
  back: string;
  done: string;
  close: string;
  /** A dot's accessible name, e.g. "Go to slide 3". */
  goTo: (n: number) => string;
}

export interface WhatsNewDialogProps {
  open: boolean;
  /** Every way out ends here: Got it, the close button, Esc, the backdrop. */
  onClose: () => void;
  copy: WhatsNewCopy;
  labels: WhatsNewLabels;
  dir?: 'ltr' | 'rtl';
}

/* Dot geometry: 8px dots, 6px apart; the current one is 18px longer. */
const DOT = 8;
const GAP = 6;
const STRETCH = 18;
/* How far a slide travels as it crosses; the picture travels further. */
const SLIDE_SHIFT = 28;
const EXIT_MS = 220;
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

/** A slide as the dialog walks it: the notes' slides, then the finale. */
interface Step extends WhatsNewSlide {
  finale?: boolean;
}

/**
 * The headline in pieces that rise one after another. Each piece is an
 * inline-block, and the bidi algorithm orders inline-blocks as single
 * neutral objects: "Sara CRM" split into two would read "CRM Sara" inside an
 * Arabic headline. So consecutive words of the same script stay together.
 */
function headlineChunks(text: string, rtl: boolean): string[] {
  const arabic = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFC]/;
  const out: string[] = [];
  let prevForeign = false;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    // "Foreign" = written in the other direction from the paragraph's.
    const foreign = arabic.test(word) !== rtl;
    if (foreign && prevForeign && out.length > 0) out[out.length - 1] += ` ${word}`;
    else out.push(word);
    prevForeign = foreign;
  }
  return out;
}

function delay(ms: number): CSSProperties {
  return { '--d': `${ms}ms` } as CSSProperties;
}

/** The picture's frame: a soft indigo stage with a faint dot grid. */
function ArtStage({
  kind,
  finale,
  stageRef,
}: {
  kind: WhatsNewArtKind;
  finale?: boolean;
  stageRef?: Ref<HTMLDivElement>;
}) {
  if (finale) {
    /* The finale's picture floats free: no card, just a soft glow. */
    return (
      <div
        ref={stageRef}
        aria-hidden
        className="wn-rise relative mx-auto h-[128px] w-full max-w-[300px] sm:h-[138px]"
      >
        <div className="absolute inset-x-[18%] inset-y-0 rounded-full bg-[radial-gradient(closest-side,oklch(var(--primary)/0.14),transparent)]" />
        <div className="absolute inset-0">
          <WhatsNewArt kind={kind} />
        </div>
      </div>
    );
  }
  return (
    <div
      ref={stageRef}
      aria-hidden
      className="wn-rise relative h-[148px] overflow-hidden rounded-[22px] bg-primary/[0.06] ring-1 ring-inset ring-primary/[0.08] sm:h-[172px]"
    >
      <div className="absolute inset-0 bg-[radial-gradient(oklch(var(--primary)/0.16)_1px,transparent_1.3px)] [background-size:14px_14px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_78%)]" />
      <div className="absolute -start-10 -top-12 h-40 w-40 rounded-full bg-[radial-gradient(circle,oklch(var(--primary)/0.16),transparent_70%)]" />
      <div className="absolute inset-0 px-1.5 py-1">
        <WhatsNewArt kind={kind} />
      </div>
    </div>
  );
}

function SlideBody({ slide, stageRef }: { slide: Step; stageRef?: Ref<HTMLDivElement> }) {
  if (slide.finale) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="w-full">
          <ArtStage kind="celebrate" finale stageRef={stageRef} />
        </div>
        <div className="flex flex-col items-center gap-2">
          <h3
            className="wn-rise text-2xl font-bold leading-tight tracking-[-0.02em] text-foreground [text-wrap:balance]"
            style={delay(120)}
          >
            {slide.title}
          </h3>
          <p
            className="wn-rise max-w-[50ch] text-[0.9375rem] leading-[1.6] text-foreground/75 [text-wrap:pretty]"
            style={delay(200)}
          >
            {slide.body}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-5 sm:grid-cols-[232px_minmax(0,1fr)] sm:items-center sm:gap-7">
      <ArtStage kind={slide.art ?? 'celebrate'} />
      <div className="flex min-w-0 flex-col gap-2.5">
        <h3
          className="wn-rise text-[1.3125rem] font-bold leading-tight tracking-[-0.015em] text-foreground [text-wrap:balance]"
          style={delay(90)}
        >
          {slide.title}
        </h3>
        <p
          className="wn-rise max-w-[62ch] text-[0.9375rem] leading-[1.6] text-foreground/75 [text-wrap:pretty]"
          style={delay(160)}
        >
          {slide.body}
        </p>
        {slide.tags && slide.tags.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-2">
            {slide.tags.map((tag, i) => (
              <li
                key={tag}
                className="wn-pop rounded-full bg-primary/10 px-[11px] py-[5px] text-xs font-semibold text-primary"
                style={delay(260 + i * 70)}
              >
                {tag}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function WhatsNewDialog({
  open,
  onClose,
  copy,
  labels,
  dir = 'ltr',
}: WhatsNewDialogProps): JSX.Element | null {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const titleId = useId();
  const subId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  /* Stays mounted for the exit animation after `open` goes false. */
  const [rendered, setRendered] = useState(open);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (open) {
      setRendered(true);
      setLeaving(false);
      return;
    }
    if (!rendered) return;
    if (reduced) {
      setRendered(false);
      return;
    }
    setLeaving(true);
    const id = setTimeout(() => {
      setRendered(false);
      setLeaving(false);
    }, EXIT_MS);
    return () => clearTimeout(id);
    // `rendered` is read, not followed: this reacts to `open` changing.
  }, [open, reduced]);

  /* The notes' slides, then the finale when the notes have one. */
  const steps = useMemo<Step[]>(
    () =>
      copy.outro
        ? [...copy.slides, { title: copy.outro.title, body: copy.outro.body, finale: true }]
        : [...copy.slides],
    [copy],
  );
  const total = steps.length;
  const [step, setStep] = useState(0);
  /* +1 moving forward, -1 back — decides which way the slides travel. */
  const [heading, setHeading] = useState<1 | -1>(1);
  /* The slide on its way out, kept for one short animation (cross-slide). */
  const [outgoing, setOutgoing] = useState<{ index: number; id: number } | null>(null);
  /* Where the finale's confetti bursts from, measured once per arrival. */
  const [burst, setBurst] = useState<{ x: number; y: number; id: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setOutgoing(null);
    setBurst(null);
  }, [open]);

  useEffect(() => {
    if (!outgoing) return;
    const id = setTimeout(() => setOutgoing(null), EXIT_MS + 40);
    return () => clearTimeout(id);
  }, [outgoing]);

  const go = useCallback(
    (to: number) => {
      if (to === step || to < 0 || to >= total) return;
      setHeading(to > step ? 1 : -1);
      if (!reduced) setOutgoing({ index: step, id: Date.now() });
      setStep(to);
    },
    [reduced, step, total],
  );

  const current = Math.min(step, total - 1);
  const slide = steps[current];
  const onFinale = !!slide?.finale;

  /* Arriving on the finale: one burst from the middle of its picture. A
     single layout read, after the slide has mounted. */
  useLayoutEffect(() => {
    if (!open || !onFinale || reduced) {
      setBurst(null);
      return;
    }
    const panel = panelRef.current;
    const stage = stageRef.current;
    if (!panel || !stage) return;
    /* Layout offsets, not the bounding box: the slide is mid-animation
       (translated) when this runs, and the burst wants where it settles. */
    let x = stage.offsetWidth / 2;
    let y = stage.offsetHeight / 2;
    let el: HTMLElement | null = stage;
    while (el && el !== panel) {
      x += el.offsetLeft;
      y += el.offsetTop;
      el = el.offsetParent as HTMLElement | null;
    }
    setBurst({ x, y, id: Date.now() });
  }, [open, onFinale, reduced]);

  /* Esc closes (and counts as seen); arrows walk the tour, mirrored in RTL;
     the page behind does not scroll. */
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const forward = (e.key === 'ArrowRight') === (dir !== 'rtl');
      go(current + (forward ? 1 : -1));
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, go, current, dir]);

  useFocusTrap(panelRef, open && rendered);
  /* Start on the main action, so Enter walks the tour. Runs after the trap's
     own first-focus frame. */
  useEffect(() => {
    if (!open || !rendered) return;
    const raf = requestAnimationFrame(() => nextRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, rendered]);

  if (!rendered || typeof document === 'undefined') return null;
  if (!slide) return null;

  const last = current === total - 1;
  const leavingSlide = outgoing ? steps[outgoing.index] : undefined;

  /* Forward travels toward the reading start: in from the end, out to the
     start. RTL mirrors it. */
  const sign = (dir === 'rtl' ? -1 : 1) * heading;
  const inStyle = { '--wn-from': `${SLIDE_SHIFT * sign}px` } as CSSProperties;
  const outStyle = { '--wn-to': `${-SLIDE_SHIFT * sign}px` } as CSSProperties;
  const dirSign = dir === 'rtl' ? -1 : 1;
  const dotsWidth = total * DOT + (total - 1) * GAP + STRETCH;
  const dotMotion = reduced ? undefined : `transform 280ms ${EASE}, background-color 280ms ${EASE}`;
  const words = headlineChunks(copy.headline, dir === 'rtl');

  const press =
    'transition-[background-color,transform] duration-fast ease-out motion-safe:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card';

  return createPortal(
    <>
      <style>{WHATS_NEW_STYLES}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subId}
        data-whats-new=""
        data-motion={reduced ? 'reduce' : 'full'}
        dir={dir}
        className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6"
      >
        <div
          aria-hidden
          onClick={onClose}
          className={cn(
            'absolute inset-0 bg-[rgb(20_18_40/0.42)] backdrop-blur-[4px]',
            !reduced && (leaving ? 'animate-wn-fade-out' : 'animate-wn-backdrop'),
          )}
        />

        <div
          ref={panelRef}
          data-whats-new-panel=""
          className={cn(
            'relative flex max-h-[calc(100dvh-0.75rem)] w-full flex-col overflow-hidden bg-card text-card-foreground',
            'rounded-t-[28px] sm:max-h-[calc(100dvh-3rem)] sm:max-w-[720px] sm:rounded-[28px]',
            'shadow-[0_50px_100px_-40px_rgb(20_18_40/0.75),0_0_0_1px_rgb(255_255_255/0.04),inset_0_1px_0_rgb(255_255_255/0.6)]',
            !reduced &&
              (leaving
                ? 'animate-wn-sheet-out sm:animate-wn-pop-out'
                : 'animate-wn-sheet sm:animate-wn-pop'),
          )}
        >
          {/* Header: ink into indigo, a drifting aurora, an orbiting mark. */}
          <div className="relative flex min-h-[176px] shrink-0 items-end overflow-hidden bg-[linear-gradient(135deg,#121120_0%,#1d1850_48%,#2f2590_100%)] px-6 pb-7 pt-14 sm:min-h-[212px] sm:px-8 sm:pe-[256px]">
            <WhatsNewHeroBackdrop />
            <button
              type="button"
              onClick={onClose}
              aria-label={labels.close}
              title={labels.close}
              className="absolute end-4 top-4 z-10 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white/80 backdrop-blur-sm transition-[background-color,color,transform] duration-fast ease-out hover:bg-white/20 hover:text-white motion-safe:active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="h-4 w-4"
                aria-hidden
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
            <div className="relative flex flex-col gap-3">
              <span className="wn-badge relative self-start overflow-hidden rounded-full bg-white/[0.14] px-3 py-[5px] text-xs font-bold tracking-[0.02em] text-[#ecebff] ring-1 ring-inset ring-white/15">
                <span className="relative">{labels.badge}</span>
                <span
                  aria-hidden
                  className="wn-badge-sheen pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.45),transparent)]"
                />
              </span>
              <h2
                id={titleId}
                className="text-[1.75rem] font-bold leading-[1.08] tracking-[-0.025em] text-white [text-wrap:balance] sm:text-[2.25rem]"
              >
                {words.map((word, i) => (
                  <Fragment key={`${i}-${word}`}>
                    {i > 0 && ' '}
                    <span className="wn-word inline-block" style={delay(300 + i * 70)}>
                      {word}
                    </span>
                  </Fragment>
                ))}
              </h2>
              <p
                id={subId}
                className="wn-sub max-w-[46ch] text-sm font-medium leading-relaxed text-[#cfcdee]"
                style={delay(320 + words.length * 70)}
              >
                {copy.sub}
              </p>
            </div>
            {/* The whole tour's progress, along the header's foot. */}
            <div aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-white/10">
              <div
                className="h-full bg-[linear-gradient(90deg,#8b7cff,#c9c2ff_60%,#f3c969)]"
                style={{
                  transform: `scaleX(${(current + 1) / total})`,
                  transformOrigin: dir === 'rtl' ? 'right' : 'left',
                  transition: reduced ? undefined : `transform 520ms ${EASE}`,
                }}
              />
            </div>
          </div>

          {/* Body: the slide, which may scroll on a short phone. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-2 pt-5 sm:px-8 sm:pt-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="text-xs font-bold tabular-nums text-muted-foreground">
                {labels.step(current + 1, total)}
              </span>
              {copy.audienceLabel && (
                <span className="inline-flex min-w-0 items-center gap-1.5 truncate rounded-full bg-primary/[0.08] px-2.5 py-1 text-xs font-semibold text-primary">
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span className="truncate">{copy.audienceLabel}</span>
                </span>
              )}
            </div>
            {/* Both slides share one grid cell while they cross, so the height
                never jumps between a short slide and a long one. */}
            <div aria-live="polite" className="grid min-h-[172px] overflow-hidden sm:min-h-[196px]">
              {leavingSlide && outgoing && (
                <div
                  key={`out-${outgoing.id}`}
                  aria-hidden
                  style={outStyle}
                  className="pointer-events-none col-start-1 row-start-1 self-center animate-wn-slide-out"
                >
                  <SlideBody slide={leavingSlide} />
                </div>
              )}
              <div
                key={`in-${current}`}
                role="group"
                aria-roledescription="slide"
                aria-label={labels.step(current + 1, total)}
                style={reduced ? undefined : inStyle}
                className={cn(
                  'col-start-1 row-start-1 self-center',
                  !reduced && 'animate-wn-slide-in',
                )}
                data-slide-index={current}
              >
                <SlideBody slide={slide} stageRef={slide.finale ? stageRef : undefined} />
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-between gap-4 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[18px] sm:px-8 sm:pb-[26px]">
            {/* Progress. Every part moves by transform: the current dot is a
                start cap, a bar that grows, and an end cap that travels. */}
            <div
              role="group"
              aria-label={labels.step(current + 1, total)}
              className="relative h-6 shrink-0"
              style={{ width: dotsWidth }}
            >
              {steps.map((s, i) => {
                const active = i === current;
                const x = i * (DOT + GAP) + (i > current ? STRETCH : 0);
                const tone = active
                  ? 'bg-primary'
                  : i < current
                    ? 'bg-primary/35'
                    : 'bg-foreground/[0.16]';
                return (
                  <button
                    key={`${i}-${s.title}`}
                    type="button"
                    onClick={() => go(i)}
                    aria-label={labels.goTo(i + 1)}
                    aria-current={active ? 'step' : undefined}
                    className="absolute start-0 top-0 h-6 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    style={{
                      width: DOT + (active ? STRETCH : 0),
                      transform: `translateX(${x * dirSign}px)`,
                      transition: reduced ? undefined : `transform 280ms ${EASE}`,
                    }}
                  >
                    <span
                      aria-hidden
                      className={cn('absolute start-0 top-2 h-2 w-2 rounded-full', tone)}
                      style={{ transition: dotMotion }}
                    />
                    <span
                      aria-hidden
                      className={cn('absolute start-1 top-2 h-2', tone)}
                      style={{
                        width: STRETCH,
                        transformOrigin: dir === 'rtl' ? 'right' : 'left',
                        transform: `scaleX(${active ? 1 : 0})`,
                        transition: dotMotion,
                      }}
                    />
                    <span
                      aria-hidden
                      className={cn('absolute start-0 top-2 h-2 w-2 rounded-full', tone)}
                      style={{
                        transform: `translateX(${(active ? STRETCH : 0) * dirSign}px)`,
                        transition: dotMotion,
                      }}
                    />
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2.5">
              {current > 0 && (
                <button
                  type="button"
                  onClick={() => go(current - 1)}
                  className={cn(
                    'h-11 rounded-full bg-primary/10 px-5 text-sm font-semibold text-primary hover:bg-primary/[0.17]',
                    press,
                  )}
                >
                  {labels.back}
                </button>
              )}
              <button
                ref={nextRef}
                type="button"
                onClick={() => (last ? onClose() : go(current + 1))}
                className={cn(
                  'relative h-11 overflow-hidden rounded-full px-6 text-sm font-semibold',
                  last
                    ? 'bg-primary text-primary-foreground shadow-[0_10px_24px_-10px_oklch(var(--primary)/0.9)] hover:bg-primary/90'
                    : 'bg-ink text-ink-foreground hover:bg-ink/90',
                  press,
                )}
              >
                <span className="relative inline-flex items-center gap-2">
                  {last ? labels.done : labels.next}
                  {last && (
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={cn('wn-cta-arrow h-4 w-4', dir === 'rtl' && '-scale-x-100')}
                      aria-hidden
                    >
                      <path d="M3 8h10M9 4l4 4-4 4" />
                    </svg>
                  )}
                </span>
                {last && (
                  <span
                    aria-hidden
                    className="wn-cta-sheen pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.35),transparent)]"
                  />
                )}
              </button>
            </div>
          </div>

          {burst && <WhatsNewConfetti key={burst.id} x={burst.x} y={burst.y} />}
        </div>
      </div>
    </>,
    document.body,
  );
}

/* ── Provider: when it appears, and the menu's way back in ──────────────── */

export interface WhatsNewContextValue {
  /** There are notes for this person in this release. */
  available: boolean;
  isOpen: boolean;
  /** Reopen the tour (the help panel's "What's new"). */
  open: () => void;
}

const WhatsNewContext = createContext<WhatsNewContextValue | null>(null);

/** The tour's controls, or null outside a provider (nobody to show it to). */
export function useWhatsNew(): WhatsNewContextValue | null {
  return useContext(WhatsNewContext);
}

export interface WhatsNewProviderProps {
  /** Which portal this is; "seen" is remembered per portal. */
  portal: string;
  userId: string | null | undefined;
  version: string;
  /** This person's copy, or null for nobody-sees-it. */
  copy: WhatsNewCopy | null;
  labels: WhatsNewLabels;
  dir?: 'ltr' | 'rtl';
  /** Wait after the shell renders before showing it. */
  delayMs?: number;
  children?: ReactNode;
}

export function WhatsNewProvider({
  portal,
  userId,
  version,
  copy,
  labels,
  dir,
  delayMs = 600,
  children,
}: WhatsNewProviderProps): JSX.Element {
  const available = !!copy && !!userId;
  const [isOpen, setIsOpen] = useState(false);

  /* Once per version: after the shell has settled, and never on top of
     another modal — it waits for that one to close. */
  useEffect(() => {
    if (!available || !userId) return;
    if (hasSeenWhatsNew(portal, userId, version)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      if (otherModalOpen()) {
        timer = setTimeout(attempt, 1000);
        return;
      }
      setIsOpen(true);
    };
    timer = setTimeout(attempt, delayMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [available, portal, userId, version, delayMs]);

  const close = useCallback(() => {
    setIsOpen(false);
    if (userId) markWhatsNewSeen(portal, userId, version);
  }, [portal, userId, version]);

  const open = useCallback(() => {
    if (available) setIsOpen(true);
  }, [available]);

  const value = useMemo(() => ({ available, isOpen, open }), [available, isOpen, open]);

  return (
    <WhatsNewContext.Provider value={value}>
      {children}
      {copy && (
        <WhatsNewDialog open={isOpen} onClose={close} copy={copy} labels={labels} dir={dir} />
      )}
    </WhatsNewContext.Provider>
  );
}
