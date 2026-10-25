import type { CSSProperties, JSX, ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';
import { useFocusTrap } from './useFocusTrap.js';
import { useMediaQuery } from './useMediaQuery.js';

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
}

export interface WhatsNewCopy {
  headline: string;
  sub: string;
  /** Who this tour is written for, e.g. "For WeCare Agents". */
  audienceLabel?: string;
  slides: readonly WhatsNewSlide[];
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
const SLIDE_SHIFT = 16;
const EXIT_MS = 220;
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

function SparkGlyph() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3l2.4 5.1 5.6.7-4.1 3.9 1 5.5L12 15.6 7.1 18.2l1-5.5L4 8.8l5.6-.7z" />
    </svg>
  );
}

function SlideBody({ slide }: { slide: WhatsNewSlide }) {
  return (
    <div className="flex items-start gap-4 sm:gap-[18px]">
      <div
        aria-hidden
        className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary sm:h-[52px] sm:w-[52px]"
      >
        <SparkGlyph />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="text-xl font-bold leading-tight tracking-[-0.01em] text-foreground [text-wrap:balance]">
          {slide.title}
        </h3>
        <p className="max-w-[62ch] text-[0.9375rem] leading-[1.55] text-foreground/80 [text-wrap:pretty]">
          {slide.body}
        </p>
        {slide.tags && slide.tags.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-2">
            {slide.tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full bg-primary/10 px-[11px] py-[5px] text-xs font-semibold text-primary"
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

  const total = copy.slides.length;
  const [step, setStep] = useState(0);
  /* +1 moving forward, -1 back — decides which way the slides travel. */
  const [heading, setHeading] = useState<1 | -1>(1);
  /* The slide on its way out, kept for one short animation (cross-slide). */
  const [outgoing, setOutgoing] = useState<{ index: number; id: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setOutgoing(null);
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

  /* Esc closes (and counts as seen); the page behind does not scroll. */
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  useFocusTrap(panelRef, open && rendered);
  /* Start on the main action, so Enter walks the tour. Runs after the trap's
     own first-focus frame. */
  useEffect(() => {
    if (!open || !rendered) return;
    const raf = requestAnimationFrame(() => nextRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, rendered]);

  if (!rendered || typeof document === 'undefined') return null;

  const current = Math.min(step, total - 1);
  const last = current === total - 1;
  const slide = copy.slides[current];
  if (!slide) return null;
  const leavingSlide = outgoing ? copy.slides[outgoing.index] : undefined;

  /* Forward travels toward the reading start: in from the end, out to the
     start. RTL mirrors it. */
  const sign = (dir === 'rtl' ? -1 : 1) * heading;
  const inStyle = { '--wn-from': `${SLIDE_SHIFT * sign}px` } as CSSProperties;
  const outStyle = { '--wn-to': `${-SLIDE_SHIFT * sign}px` } as CSSProperties;
  const dirSign = dir === 'rtl' ? -1 : 1;
  const dotsWidth = total * DOT + (total - 1) * GAP + STRETCH;
  const dotMotion = reduced ? undefined : `transform 280ms ${EASE}, background-color 280ms ${EASE}`;

  const press =
    'transition-[background-color,transform] duration-fast ease-out motion-safe:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card';

  return createPortal(
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
          'absolute inset-0 bg-[rgb(20_18_40/0.38)] backdrop-blur-[3px]',
          !reduced && (leaving ? 'animate-wn-fade-out' : 'animate-wn-backdrop'),
        )}
      />

      <div
        ref={panelRef}
        data-whats-new-panel=""
        className={cn(
          'relative flex max-h-[calc(100dvh-0.75rem)] w-full flex-col overflow-hidden bg-card text-card-foreground',
          'rounded-t-[28px] sm:max-h-[calc(100dvh-3rem)] sm:max-w-[660px] sm:rounded-[28px]',
          'shadow-[0_40px_90px_-40px_rgb(20_18_40/0.7),inset_0_1px_0_rgb(255_255_255/0.6)]',
          !reduced &&
            (leaving
              ? 'animate-wn-sheet-out sm:animate-wn-pop-out'
              : 'animate-wn-sheet sm:animate-wn-pop'),
        )}
      >
        {/* Header: ink into indigo, a slow glow, two quiet rings. */}
        <div className="relative flex min-h-[168px] shrink-0 items-end overflow-hidden bg-[linear-gradient(135deg,#17191f_0%,#2a2470_100%)] px-6 pb-6 pt-14 sm:min-h-[190px] sm:px-8 sm:pb-7">
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute -end-[60px] -top-[80px] h-[280px] w-[280px] rounded-full opacity-60',
              'bg-[radial-gradient(circle,rgb(132_118_255/0.9),rgb(75_59_213/0)_70%)]',
              !reduced && 'animate-wn-glow',
            )}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute end-12 top-10 hidden sm:block h-[120px] w-[120px] rounded-full border-2 border-white/[0.14]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute end-[78px] top-[70px] hidden sm:block h-[60px] w-[60px] rounded-full border-2 border-white/[0.22]"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={labels.close}
            title={labels.close}
            className="absolute end-4 top-4 z-10 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white/80 transition-[background-color,color,transform] duration-fast ease-out hover:bg-white/20 hover:text-white motion-safe:active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
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
          <div className="relative flex flex-col gap-2.5">
            <span className="self-start rounded-full bg-white/[0.14] px-3 py-[5px] text-xs font-bold tracking-[0.02em] text-[#ecebff]">
              {labels.badge}
            </span>
            <h2
              id={titleId}
              className="text-[1.625rem] font-bold leading-[1.1] tracking-[-0.02em] text-white [text-wrap:balance] sm:text-[2rem]"
            >
              {copy.headline}
            </h2>
            <p id={subId} className="text-sm font-medium text-[#c9c7e8]">
              {copy.sub}
            </p>
          </div>
        </div>

        {/* Body: the slide, which may scroll on a short phone. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-2 pt-6 sm:px-8 sm:pt-[26px]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-xs font-bold tabular-nums text-muted-foreground">
              {labels.step(current + 1, total)}
            </span>
            {copy.audienceLabel && (
              <span className="truncate text-xs font-semibold text-primary">
                {copy.audienceLabel}
              </span>
            )}
          </div>
          {/* Both slides share one grid cell while they cross, so the height
              never jumps between a short slide and a long one. */}
          <div aria-live="polite" className="grid min-h-[150px] overflow-hidden">
            {leavingSlide && outgoing && (
              <div
                key={`out-${outgoing.id}`}
                aria-hidden
                style={outStyle}
                className="pointer-events-none col-start-1 row-start-1 animate-wn-slide-out"
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
              className={cn('col-start-1 row-start-1', !reduced && 'animate-wn-slide-in')}
              data-slide-index={current}
            >
              <SlideBody slide={slide} />
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
            {copy.slides.map((s, i) => {
              const active = i === current;
              const x = i * (DOT + GAP) + (i > current ? STRETCH : 0);
              const tone = active ? 'bg-primary' : 'bg-foreground/[0.16]';
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
                'h-11 rounded-full bg-ink px-6 text-sm font-semibold text-ink-foreground hover:bg-ink/90',
                press,
              )}
            >
              {last ? labels.done : labels.next}
            </button>
          </div>
        </div>
      </div>
    </div>,
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
