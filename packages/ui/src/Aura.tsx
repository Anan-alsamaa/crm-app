import type { CSSProperties, JSX, ReactNode, UIEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { cn } from './cn.js';
import { Drawer } from './Drawer.js';
import { Pill } from './Pill.js';

/*
 * AURA — the in-app help assistant's face (owner, 2026-10-26: "the AI Aura
 * interface could also be 1000 times better").
 *
 * Both portals used to carry their own 700-line copy of the same panel, and
 * the two had already drifted (one header indigo, one white; different radii,
 * different launcher). The LOOK now lives here once; each portal keeps what is
 * genuinely its own: the gateway call, the transcript state, the error
 * wording, its starter questions and the action card an admin can confirm.
 *
 * Like the What's new tour, this package renders no copy of its own: every
 * visible word arrives through `labels`, so the Arabic-coverage guard keeps
 * seeing each key at its `t()` call in the portal.
 *
 * Motion: one stylesheet below, every animation inside
 * `prefers-reduced-motion: no-preference`. The un-animated styles ARE the
 * finished state, so reduced motion simply shows the last frame: a still mark,
 * solid typing dots, messages that appear without travelling. Transform and
 * opacity only, so nothing here makes the page reflow.
 *
 * The sheens are the one deliberate PHYSICAL `left-0` here: they rest just
 * off the left edge and sweep rightwards in both directions. A logical
 * `start-0` parked their resting frame in the middle of the button in Arabic.
 */

/* ── Stylesheet ────────────────────────────────────────────────────────── */

const OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const SPRING = 'cubic-bezier(0.2, 0.9, 0.25, 1.15)';

export const AURA_STYLES = `
.aura-text-shimmer{background-image:linear-gradient(90deg,oklch(var(--muted-foreground)) 0%,oklch(var(--muted-foreground)) 35%,oklch(var(--primary)) 50%,oklch(var(--muted-foreground)) 65%,oklch(var(--muted-foreground)) 100%);background-size:250% 100%;background-position:0 0;-webkit-background-clip:text;background-clip:text;color:transparent}
@keyframes auraSpin{to{transform:rotate(360deg)}}
@keyframes auraBreathe{0%,100%{opacity:.5;transform:scale(.9)}50%{opacity:.95;transform:scale(1.08)}}
@keyframes auraTwinkle{0%,100%{transform:scale(1) rotate(0deg)}50%{transform:scale(.84) rotate(45deg)}}
@keyframes auraIn{0%{opacity:0;transform:translateY(10px) scale(.985)}100%{opacity:1;transform:none}}
@keyframes auraPop{0%{opacity:0;transform:scale(.6)}65%{opacity:1;transform:scale(1.06)}100%{opacity:1;transform:none}}
@keyframes auraDot{0%,70%,100%{transform:translateY(0);opacity:.35}35%{transform:translateY(-4px);opacity:1}}
@keyframes auraShimmer{0%{background-position:125% 0}100%{background-position:-125% 0}}
@keyframes auraSheen{0%{transform:translateX(-160%) skewX(-20deg)}50%,100%{transform:translateX(420%) skewX(-20deg)}}
@keyframes auraDriftA{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(-40px,22px,0) scale(1.18)}}
@keyframes auraDriftB{0%,100%{transform:translate3d(0,0,0) scale(1.05)}50%{transform:translate3d(46px,-14px,0) scale(.92)}}
@keyframes auraPing{0%{opacity:.7;transform:scale(1)}100%{opacity:0;transform:scale(2.4)}}
@media (prefers-reduced-motion: no-preference){
.aura-spin{animation:auraSpin 10s linear infinite}
[data-aura-state="thinking"] .aura-spin{animation-duration:1.3s}
.aura-breathe{animation:auraBreathe 5s ease-in-out infinite}
[data-aura-state="thinking"] .aura-breathe{animation-duration:1.4s}
.aura-twinkle{animation:auraTwinkle 5s ease-in-out infinite}
.aura-in{animation:auraIn .44s ${OUT} var(--aura-d,0ms) backwards}
.aura-pop{animation:auraPop .6s ${SPRING} var(--aura-d,0ms) backwards}
.aura-dot{animation:auraDot 1.15s ease-in-out infinite}
.aura-text-shimmer{animation:auraShimmer 2.2s linear infinite}
.aura-sheen{animation:auraSheen 5s ease-in-out 1.4s infinite}
.aura-drift-a{animation:auraDriftA 16s ease-in-out infinite}
.aura-drift-b{animation:auraDriftB 20s ease-in-out infinite}
.aura-ping{animation:auraPing 2.2s cubic-bezier(.2,.6,.35,1) infinite}
.aura-launch:hover .aura-spin{animation-duration:2.2s}
}
`;

const STYLE_ID = 'sara-aura-styles';

/** Inject the stylesheet once per document, whoever renders first. */
function useAuraStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = AURA_STYLES;
    document.head.appendChild(el);
  }, []);
}

const delay = (ms: number): CSSProperties => ({ '--aura-d': `${ms}ms` }) as CSSProperties;

/* ── The mark ──────────────────────────────────────────────────────────── */

export interface AuraMarkProps {
  /** Diameter in px. */
  size?: number;
  /**
   * `still` never moves (a message avatar seen dozens of times a session);
   * `live` turns slowly and breathes; `thinking` turns fast while she answers.
   */
  state?: 'still' | 'live' | 'thinking';
  className?: string;
}

/**
 * Aura's mark: a brand-indigo orb inside a turning aurora ring, a soft halo,
 * and the four-point spark the rest of the product uses for AI.
 */
export function AuraMark({ size = 40, state = 'still', className }: AuraMarkProps): JSX.Element {
  useAuraStyles();
  const moving = state !== 'still';
  const ring = Math.max(1.5, Math.round(size / 18));
  return (
    <span
      aria-hidden
      data-aura-state={state}
      className={cn('relative inline-block shrink-0', className)}
      style={{ width: size, height: size }}
    >
      {moving && (
        <span className="aura-breathe absolute -inset-[22%] rounded-full bg-[radial-gradient(circle,rgb(124_108_255/0.55),rgb(124_108_255/0)_68%)]" />
      )}
      <span
        className={cn(
          'absolute inset-0 rounded-full',
          moving && 'aura-spin',
          'bg-[conic-gradient(from_210deg,#4B3BD5,#7C6CFF,#C478FF,#6E8BFF,#4B3BD5)]',
        )}
      />
      <span
        className="absolute rounded-full bg-[radial-gradient(circle_at_32%_26%,#9C90FF_0%,#5B4BE6_45%,#3A2BB8_100%)] shadow-[inset_0_1px_1px_rgb(255_255_255/0.35)]"
        style={{ inset: ring }}
      />
      <svg
        viewBox="0 0 24 24"
        className={cn('absolute inset-0 m-auto text-white', moving && 'aura-twinkle')}
        style={{ width: size * 0.48, height: size * 0.48 }}
        fill="currentColor"
      >
        <path d="M12 3.2c.5 3.9 2.1 5.9 6.3 7.1-4.2 1.2-5.8 3.2-6.3 7.1-.5-3.9-2.1-5.9-6.3-7.1C9.9 9.1 11.5 7.1 12 3.2Z" />
        <path
          d="M18.4 15.6c.2 1.4.8 2.1 2.2 2.5-1.4.4-2 1.1-2.2 2.5-.2-1.4-.8-2.1-2.2-2.5 1.4-.4 2-1.1 2.2-2.5Z"
          opacity=".75"
        />
      </svg>
    </span>
  );
}

/* ── The header button ─────────────────────────────────────────────────── */

export interface AuraLauncherProps {
  /** Accessible name and tooltip, e.g. "Ask AI help". */
  label: string;
  onClick: () => void;
  className?: string;
}

/**
 * The round "AI" control in each portal's top bar: the living mark and the two
 * letters people already look for. It turns slowly at rest and faster on
 * hover; a gentle sheen crosses it now and then. Nothing pulses or bounces:
 * it sits in a bar people look at all shift.
 */
export function AuraLauncher({ label, onClick, className }: AuraLauncherProps): JSX.Element {
  useAuraStyles();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-aura-launcher=""
      className={cn(
        'aura-launch group relative inline-flex h-9 items-center gap-1.5 overflow-hidden rounded-full pe-2.5 ps-1',
        'text-xs font-bold tracking-[0.04em] text-foreground',
        'transition-[background-color,transform] duration-fast ease-out hover:bg-primary/[0.07] motion-safe:active:scale-[0.96]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
    >
      <AuraMark size={26} state="live" />
      <span className="bg-[linear-gradient(120deg,#4B3BD5,#8B5CF6)] bg-clip-text text-transparent dark:bg-[linear-gradient(120deg,#A99FFF,#D6B4FF)]">
        AI
      </span>
      <span
        aria-hidden
        className="aura-sheen pointer-events-none absolute inset-y-0 left-0 w-1/3 -translate-x-[160%] bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.55),transparent)]"
      />
    </button>
  );
}

/* ── Answer text ───────────────────────────────────────────────────────── */

const LIST_ITEM = /^\s*(?:(\d{1,2})[.)]|[-•*])\s+(.*)$/;

/**
 * Plain text with just enough structure: blank-line paragraphs, and runs of
 * "1." or "-" lines as real lists. The gateway asks for plain text, but steps
 * still arrive numbered, and a numbered list set as one wrapped paragraph is
 * the hardest thing in the panel to follow. Text nodes only: nothing the model
 * writes is ever parsed as HTML.
 */
export function AuraRichText({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Array<
    { kind: 'p'; lines: string[] } | { kind: 'ol' | 'ul'; items: string[]; start: number }
  > = [];
  for (const line of lines) {
    const m = LIST_ITEM.exec(line);
    const last = blocks[blocks.length - 1];
    if (m) {
      const kind = m[1] ? 'ol' : 'ul';
      if (last && last.kind === kind) last.items.push(m[2] ?? '');
      else blocks.push({ kind, items: [m[2] ?? ''], start: m[1] ? Number(m[1]) : 1 });
    } else if (!line.trim()) {
      if (last && last.kind === 'p' && last.lines.length) blocks.push({ kind: 'p', lines: [] });
    } else if (last && last.kind === 'p') {
      last.lines.push(line);
    } else {
      blocks.push({ kind: 'p', lines: [line] });
    }
  }
  const visible = blocks.filter((b) => (b.kind === 'p' ? b.lines.length > 0 : true));
  return (
    <div className="space-y-2.5">
      {visible.map((b, i) =>
        b.kind === 'p' ? (
          <p key={i} className="whitespace-pre-wrap">
            {b.lines.join('\n')}
          </p>
        ) : b.kind === 'ol' ? (
          <ol key={i} start={b.start} className="space-y-1.5">
            {b.items.map((item, j) => (
              <li key={j} className="flex gap-2.5">
                <span
                  aria-hidden
                  className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/10 text-2xs font-bold tabular-nums text-primary"
                >
                  {b.start + j}
                </span>
                <span className="min-w-0 flex-1">{item}</span>
              </li>
            ))}
          </ol>
        ) : (
          <ul key={i} className="space-y-1.5">
            {b.items.map((item, j) => (
              <li key={j} className="flex gap-2.5">
                <span
                  aria-hidden
                  className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60"
                />
                <span className="min-w-0 flex-1">{item}</span>
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/* ── Small glyphs ──────────────────────────────────────────────────────── */

function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-4 w-4 shrink-0', className)}
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

const G = {
  close: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3.5v9M3.5 8h9',
  arrowUp: 'M8 13V3.5M4 7.5 8 3.5l4 4',
  arrowDown: 'M8 3v9.5M4 8.5 8 12.5l4-4',
  chevron: 'M6 3.5 10.5 8 6 12.5',
  copy: 'M5.5 5.5V3.8c0-.7.6-1.3 1.3-1.3h5.4c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3h-1.7M3.8 5.5h5.4c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3H3.8c-.7 0-1.3-.6-1.3-1.3V6.8c0-.7.6-1.3 1.3-1.3Z',
  check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  alert:
    'M8 5.5v3M8 11h.01M7.1 2.6 1.9 11.6c-.4.7.1 1.6.9 1.6h10.4c.8 0 1.3-.9.9-1.6L8.9 2.6c-.4-.7-1.4-.7-1.8 0Z',
  retry: 'M2.8 8a5.2 5.2 0 1 0 1.6-3.8M2.8 2.8v2.6h2.6',
  lock: 'M4.5 7.2V5.5a3.5 3.5 0 0 1 7 0v1.7M3.8 7.2h8.4c.4 0 .8.4.8.8v5c0 .4-.4.8-.8.8H3.8c-.4 0-.8-.4-.8-.8V8c0-.4.4-.8.8-.8Z',
};

function Spark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn('h-3.5 w-3.5 shrink-0', className)}
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 1.6c.4 2.7 1.5 4 4.4 4.9-2.9.9-4 2.2-4.4 4.9-.4-2.7-1.5-4-4.4-4.9C6.5 5.6 7.6 4.3 8 1.6Z" />
      <path d="M12.6 10.4l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5.5-1.4Z" opacity=".7" />
    </svg>
  );
}

/* ── The panel ─────────────────────────────────────────────────────────── */

/** One message on screen. Portals may extend it (an admin's action card). */
export interface AuraTurn {
  role: 'user' | 'assistant';
  content: string;
  /** The gateway judged the question out of scope; the reply is a refusal. */
  offTopic?: boolean;
  /** Aura's own opening line, seeded locally and never sent as history. */
  welcome?: boolean;
}

export interface AuraSuggestion {
  key: string;
  /** A two- or three-word heading for the card. */
  title: string;
  /** The question sent when the card is pressed. */
  prompt: string;
  icon?: ReactNode;
}

export interface AuraLabels {
  /** The assistant's name, "Aura". */
  name: string;
  /** Under the name, "CRM assistant". */
  role: string;
  /** Composer field accessible name. */
  field: string;
  placeholder: string;
  /** Send button accessible name. */
  send: string;
  /** "Enter to send · Shift+Enter for a new line" — pieces for the kbd hint. */
  enterToSend: string;
  newLine: string;
  caveat: string;
  /** `{{chars}}/{{max}}`, already formatted. */
  counter: (chars: number, max: number) => string;
  thinking: string;
  offTopic: string;
  newChat: string;
  close: string;
  jumpToLatest: string;
  tryAsking: string;
  copy: string;
  copied: string;
  retry: string;
  /** The empty state's privacy line. */
  privacy: string;
  /** The conversation region's accessible name. */
  log: string;
  /** "What's new", in the header. */
  whatsNew: string;
  /** The empty-state card that opens the tour: a heading and a line. */
  whatsNewCardTitle: string;
  whatsNewCardBody: string;
}

export interface AuraPanelProps<T extends AuraTurn = AuraTurn> {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  turns: readonly T[];
  /** A question is in flight. */
  pending: boolean;
  /** The last request's failure, worded for a person; null when there is none. */
  error: string | null;
  /** Ask the failed question again. */
  onRetry?: () => void;
  onSend: (question: string) => void;
  /** The empty state: a greeting, a line under it, and starter questions. */
  greeting: string;
  intro: string;
  suggestions: readonly AuraSuggestion[];
  /** Present when there is a release tour for this person. */
  onWhatsNew?: (() => void) | null;
  /** Anything a portal draws under one of Aura's replies (an action card). */
  renderExtra?: (turn: T) => ReactNode;
  labels: AuraLabels;
  minLength?: number;
  maxLength?: number;
}

const iconBtn = cn(
  'grid h-9 w-9 shrink-0 place-items-center rounded-full text-foreground/70',
  'bg-card/70 ring-1 ring-inset ring-foreground/[0.07] shadow-[0_4px_14px_-8px_oklch(var(--shadow-color)/0.35)]',
  'transition-[background-color,color,transform] duration-fast ease-out hover:bg-card hover:text-foreground motion-safe:active:scale-[0.94]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
);

/**
 * The whole assistant drawer: header, conversation and composer.
 *
 * Owns only presentation and the things that are presentation: what is typed
 * but not yet sent, whether the reader has scrolled away from the newest
 * message, which reply was just copied. All of it lives INSIDE the drawer, so
 * closing the panel throws it away with the transcript.
 */
export function AuraPanel<T extends AuraTurn>(props: AuraPanelProps<T>): JSX.Element {
  useAuraStyles();
  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      width="md"
      hideChrome
      panelClassName={cn(
        'bg-background ring-foreground/[0.08]',
        // A phone gets the whole screen: a 32rem panel inset 12px from the
        // end edge hung off the start edge of a 390px viewport.
        '!max-w-[calc(100vw-1.5rem)] max-sm:!inset-0 max-sm:!w-full max-sm:!max-w-none max-sm:!rounded-none',
      )}
    >
      <AuraBody {...props} />
    </Drawer>
  );
}

function AuraBody<T extends AuraTurn>({
  onClose,
  onNewChat,
  turns,
  pending,
  error,
  onRetry,
  onSend,
  greeting,
  intro,
  suggestions,
  onWhatsNew,
  renderExtra,
  labels,
  minLength = 3,
  maxLength = 500,
}: AuraPanelProps<T>): JSX.Element {
  const feedRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [question, setQuestion] = useState('');
  const [copied, setCopied] = useState<number | null>(null);

  /** Something has been asked: past the greeting and the starter questions. */
  const started = turns.some((turn) => !turn.welcome);

  /*
   * Follow the newest message, but only while the reader is following.
   *
   * Nothing scrolls before the conversation starts (the greeting is the TOP of
   * a conversation), and once it has, a new message brings the view down only
   * while the reader is already near the end: yanking somebody back down while
   * they are reading an earlier answer is the other half of an old complaint.
   */
  const [atBottom, setAtBottom] = useState(true);
  const scrollToEnd = (behavior: ScrollBehavior = 'smooth') => {
    const el = feedRef.current;
    if (!el) return;
    // jsdom implements neither `scrollTo` nor smooth scrolling, and an
    // auto-scroll must never take the panel down.
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior });
    else el.scrollTop = el.scrollHeight;
  };
  useEffect(() => {
    if (!started || !atBottom) return;
    scrollToEnd();
    // `atBottom` is read, deliberately not a dependency: this follows TURNS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, pending, error, started]);

  const onFeedScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  /*
   * Put the cursor in the composer on open, on a desktop. The drawer's focus
   * trap focuses the first control (the header's What's new) a frame after
   * mount, so this waits a beat longer. Not on touch screens: focusing a field
   * there throws the keyboard over half the panel before anyone asked to type.
   */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    const id = window.setTimeout(() => composerRef.current?.focus(), 80);
    return () => window.clearTimeout(id);
  }, []);

  /* The composer takes the height of its text, up to the CSS max. Reset to
     `auto` first or scrollHeight never lets it shrink back. */
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [question]);

  const trimmed = question.trim();
  const canSend = trimmed.length >= minLength && trimmed.length <= maxLength && !pending;

  const send = (raw: string) => {
    const asked = raw.trim();
    if (asked.length < minLength || asked.length > maxLength || pending) return;
    // Asking is following: whoever sends wants to see the answer arrive.
    setAtBottom(true);
    onSend(asked);
  };
  const submit = () => {
    if (!canSend) return;
    send(question);
    setQuestion('');
  };

  const copy = async (i: number, text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(i);
      window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1600);
    } catch {
      /* clipboard refused (permissions, insecure origin) — nothing to show */
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* The ground: a brand-tinted wash with two slow aurora clouds, behind
          everything and clipped to the panel. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-[22rem] bg-[linear-gradient(180deg,oklch(var(--primary-tint)/0.9),oklch(var(--primary-tint)/0)_100%)]" />
        <span className="aura-drift-a absolute -end-24 -top-28 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgb(124_108_255/0.28),rgb(124_108_255/0)_70%)]" />
        <span className="aura-drift-b absolute -start-28 top-10 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgb(196_120_255/0.18),rgb(196_120_255/0)_70%)]" />
      </div>

      {/* Header: identity, and the three things you do to this panel. It sits
          OUTSIDE the scroller, so the transcript is the only thing that moves. */}
      <div className="relative z-10 flex shrink-0 items-center gap-3 px-4 pb-3 pt-4 sm:px-5">
        <AuraMark size={40} state={pending ? 'thinking' : 'live'} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold leading-tight tracking-[-0.01em] text-foreground">
            {labels.name}
          </h2>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs font-medium text-muted-foreground">
            <span aria-hidden className="relative inline-flex h-1.5 w-1.5 shrink-0">
              <span className="aura-ping absolute inset-0 rounded-full bg-success" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            <span className="truncate">{labels.role}</span>
          </p>
        </div>
        {onWhatsNew && (
          <button
            type="button"
            onClick={onWhatsNew}
            className={cn(
              'relative inline-flex h-9 shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full px-3.5 text-xs font-semibold text-white max-sm:w-9 max-sm:px-0',
              'bg-[linear-gradient(120deg,#4B3BD5,#7C5CF0)] shadow-[0_6px_18px_-8px_rgb(75_59_213/0.75)]',
              'transition-[transform,box-shadow] duration-fast ease-out hover:shadow-[0_8px_22px_-8px_rgb(75_59_213/0.9)] motion-safe:active:scale-[0.96]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            )}
          >
            <Spark />
            <span className="max-sm:sr-only">{labels.whatsNew}</span>
            <span
              aria-hidden
              className="aura-sheen pointer-events-none absolute inset-y-0 left-0 w-1/3 -translate-x-[160%] bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.45),transparent)]"
            />
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setQuestion('');
            onNewChat();
          }}
          aria-label={labels.newChat}
          title={labels.newChat}
          className={iconBtn}
        >
          <Glyph d={G.plus} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={labels.close}
          title={labels.close}
          className={iconBtn}
        >
          <Glyph d={G.close} />
        </button>
      </div>

      {/* The conversation. Its own scroller; bottom-anchored once underway by
          an AUTO MARGIN on the first child, never `justify-end` (which
          overflows past the start edge, where nothing can scroll to). */}
      <div
        ref={feedRef}
        onScroll={onFeedScroll}
        role="log"
        aria-label={labels.log}
        aria-live="polite"
        className={cn(
          'relative z-0 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 pb-6 pt-2 sm:px-5',
          started && '[&>*:first-child]:mt-auto',
        )}
      >
        {!started ? (
          <Welcome
            greeting={greeting}
            intro={intro}
            suggestions={suggestions}
            onPick={send}
            disabled={pending}
            onWhatsNew={onWhatsNew}
            labels={labels}
          />
        ) : (
          turns.map((turn, i) =>
            /* The greeting turn is for the model's context only: the Welcome
               screen already said hello, so repeating it as the first bubble
               of every conversation read as Aura introducing herself twice. */
            turn.welcome ? null : turn.role === 'user' ? (
              <div key={i} className="aura-in flex justify-end ps-10">
                <p className="max-w-full whitespace-pre-wrap break-words rounded-[1.25rem] rounded-ee-md bg-[linear-gradient(135deg,oklch(var(--primary)),oklch(0.5_0.2_290))] px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-[0_8px_20px_-12px_rgb(75_59_213/0.8)]">
                  {turn.content}
                </p>
              </div>
            ) : (
              <div key={i} className="aura-in flex items-start gap-2.5 pe-6">
                <AuraMark size={28} className="mt-0.5" />
                <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                  <div
                    className={cn(
                      'max-w-full break-words rounded-[1.25rem] rounded-ss-md px-4 py-3 text-sm leading-relaxed',
                      turn.offTopic
                        ? 'bg-secondary/80 text-muted-foreground ring-1 ring-inset ring-foreground/[0.06]'
                        : 'bg-card text-foreground shadow-soft ring-1 ring-foreground/[0.06]',
                    )}
                  >
                    <AuraRichText text={turn.content} />
                  </div>
                  {renderExtra?.(turn)}
                  {!turn.welcome && (
                    <div className="flex items-center gap-2 ps-1">
                      <button
                        type="button"
                        onClick={() => void copy(i, turn.content)}
                        className={cn(
                          'inline-flex h-7 items-center gap-1 rounded-full px-2 text-2xs font-semibold text-muted-foreground',
                          'transition-colors duration-fast ease-out hover:bg-foreground/[0.06] hover:text-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                        )}
                      >
                        <Glyph
                          d={copied === i ? G.check : G.copy}
                          className={cn('h-3.5 w-3.5', copied === i && 'text-success')}
                        />
                        {copied === i ? labels.copied : labels.copy}
                      </button>
                      {turn.offTopic && (
                        <Pill tone="muted" size="sm">
                          {labels.offTopic}
                        </Pill>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ),
          )
        )}

        {pending && (
          /* Aura's side, where her answer is about to land: the wait reads as
             "she is replying", not "the panel is busy". */
          <div className="aura-in flex items-start gap-2.5 pe-6">
            <AuraMark size={28} state="thinking" className="mt-0.5" />
            <div className="flex items-center gap-3 rounded-[1.25rem] rounded-ss-md bg-card px-4 py-3 shadow-soft ring-1 ring-foreground/[0.06]">
              <span className="flex items-center gap-1" aria-hidden>
                {[0, 1, 2].map((d) => (
                  <span
                    key={d}
                    className="aura-dot h-1.5 w-1.5 rounded-full bg-primary/70"
                    style={{ animationDelay: `${d * 150}ms` }}
                  />
                ))}
              </span>
              <span className="aura-text-shimmer text-xs font-semibold">{labels.thinking}</span>
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="aura-in flex items-start gap-3 rounded-2xl bg-destructive/[0.08] px-4 py-3 text-sm leading-relaxed text-destructive ring-1 ring-inset ring-destructive/20"
          >
            <Glyph d={G.alert} className="mt-0.5" />
            <span className="min-w-0 flex-1">{error}</span>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-card px-2.5 text-2xs font-semibold text-foreground ring-1 ring-inset ring-foreground/10 transition-colors duration-fast hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Glyph d={G.retry} className="h-3.5 w-3.5" />
                {labels.retry}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Back to the newest message, only while there is one out of view. */}
      {started && !atBottom && (
        <div className="pointer-events-none relative z-10">
          <button
            type="button"
            onClick={() => {
              setAtBottom(true);
              scrollToEnd();
            }}
            aria-label={labels.jumpToLatest}
            title={labels.jumpToLatest}
            className={cn(
              'pointer-events-auto absolute -top-14 start-1/2 grid h-10 w-10 -translate-x-1/2 place-items-center rounded-full rtl:translate-x-1/2',
              'bg-card text-primary ring-1 ring-primary/20 shadow-[0_10px_24px_-10px_rgb(75_59_213/0.55)] transition-transform duration-fast ease-out motion-safe:hover:scale-105',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            )}
          >
            <Glyph d={G.arrowDown} />
          </button>
        </div>
      )}

      {/* Composer: one card holding the field and its send button. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="relative z-10 shrink-0 px-3 pb-3 pt-1 sm:px-4 sm:pb-4"
      >
        <div
          className={cn(
            'rounded-[1.5rem] bg-card p-1.5 ring-1 ring-foreground/[0.09] shadow-[0_10px_30px_-18px_oklch(var(--shadow-color)/0.5)]',
            'transition-shadow duration-base ease-out focus-within:ring-2 focus-within:ring-primary/45 focus-within:shadow-[0_12px_34px_-16px_rgb(75_59_213/0.45)]',
          )}
        >
          <div className="flex items-end gap-1.5">
            <textarea
              id="help-assistant-question"
              ref={composerRef}
              aria-label={labels.field}
              rows={1}
              maxLength={maxLength}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                // Chat convention: Enter sends, Shift+Enter is a new line. Not
                // while an input method is composing (Arabic, CJK): that Enter
                // picks a candidate, it is not a send.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={labels.placeholder}
              className={cn(
                'max-h-40 min-h-[2.75rem] flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed text-foreground',
                'placeholder:text-muted-foreground/75 focus:outline-none focus-visible:shadow-none',
              )}
            />
            <button
              type="submit"
              disabled={!canSend}
              aria-label={labels.send}
              title={labels.send}
              aria-busy={pending || undefined}
              className={cn(
                'mb-0.5 me-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full transition-[background-color,color,transform,box-shadow] duration-base ease-out',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                canSend
                  ? 'bg-[linear-gradient(135deg,#4B3BD5,#7C5CF0)] text-white shadow-[0_6px_16px_-6px_rgb(75_59_213/0.8)] hover:brightness-110 motion-safe:active:scale-[0.92]'
                  : 'cursor-not-allowed bg-foreground/[0.06] text-foreground/35',
              )}
            >
              {pending ? (
                <span
                  aria-hidden
                  className="h-4 w-4 rounded-full border-2 border-primary/25 border-t-primary motion-safe:animate-spin"
                />
              ) : (
                <Glyph d={G.arrowUp} className="h-[1.1rem] w-[1.1rem]" />
              )}
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 px-3 pb-1 pt-0.5">
            <span className="hidden items-center gap-1 text-2xs text-muted-foreground sm:inline-flex">
              <kbd className="rounded-md bg-foreground/[0.06] px-1.5 py-px font-sans text-[10px] font-semibold text-foreground/70">
                Enter
              </kbd>
              {labels.enterToSend}
              <span aria-hidden className="mx-1 opacity-40">
                ·
              </span>
              <kbd className="rounded-md bg-foreground/[0.06] px-1.5 py-px font-sans text-[10px] font-semibold text-foreground/70">
                Shift + Enter
              </kbd>
              {labels.newLine}
            </span>
            <span
              data-testid="help-assistant-counter"
              className={cn(
                'ms-auto shrink-0 text-2xs tabular-nums transition-colors duration-fast',
                question.length > maxLength * 0.9
                  ? 'font-semibold text-warning'
                  : 'text-muted-foreground/80',
              )}
            >
              {labels.counter(question.length, maxLength)}
            </span>
          </div>
        </div>
        <p className="mt-2 px-2 text-center text-2xs text-muted-foreground">{labels.caveat}</p>
      </form>
    </div>
  );
}

/* ── The empty state ───────────────────────────────────────────────────── */

function Welcome({
  greeting,
  intro,
  suggestions,
  onPick,
  disabled,
  onWhatsNew,
  labels,
}: {
  greeting: string;
  intro: string;
  suggestions: readonly AuraSuggestion[];
  onPick: (prompt: string) => void;
  disabled: boolean;
  onWhatsNew?: (() => void) | null;
  labels: AuraLabels;
}): JSX.Element {
  return (
    <div className="flex flex-col">
      {/* Tighter below `sm`, so on a phone the whole welcome - starters,
          release card and privacy line - fits above the composer. */}
      <div className="flex flex-col items-center px-2 pt-1 text-center sm:pt-8">
        <span className="aura-pop -my-2 scale-[0.78] sm:my-0 sm:scale-100" style={delay(40)}>
          <AuraMark size={72} state="live" />
        </span>
        <h3
          className="aura-in mt-3 text-balance text-xl font-bold sm:mt-5 sm:text-2xl leading-tight tracking-[-0.02em] text-foreground"
          style={delay(140)}
        >
          {greeting}
        </h3>
        <p
          className="aura-in mt-1.5 max-w-[24rem] text-balance text-sm leading-snug text-muted-foreground sm:mt-2 sm:leading-relaxed"
          style={delay(220)}
        >
          {intro}
        </p>
      </div>

      {suggestions.length > 0 && (
        <div className="mt-4 sm:mt-7">
          <p
            className="aura-in mb-2.5 px-1 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
            style={delay(280)}
          >
            {labels.tryAsking}
          </p>
          <div className="grid grid-cols-1 gap-1.5 sm:gap-2">
            {suggestions.map((s, i) => (
              <button
                key={s.key}
                type="button"
                disabled={disabled}
                onClick={() => onPick(s.prompt)}
                style={delay(320 + i * 60)}
                className={cn(
                  'aura-in group flex items-start gap-3 rounded-[1.125rem] bg-card/90 px-3.5 py-2.5 text-start sm:py-3.5 shadow-soft ring-1 ring-foreground/[0.07]',
                  'transition-[box-shadow,background-color,transform] duration-base ease-out hover:bg-card hover:ring-primary/35 hover:shadow-[0_10px_26px_-14px_rgb(75_59_213/0.55)]',
                  'motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
              >
                <span
                  aria-hidden
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary-tint text-primary transition-colors duration-fast group-hover:bg-primary group-hover:text-primary-foreground"
                >
                  {s.icon ?? <Spark />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-bold text-foreground">{s.title}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                    {s.prompt}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {onWhatsNew && (
        <button
          type="button"
          onClick={onWhatsNew}
          style={delay(320 + suggestions.length * 60 + 40)}
          className={cn(
            'aura-in group relative mt-2 flex items-center gap-3 overflow-hidden rounded-[1.125rem] px-3.5 py-2.5 text-start text-white sm:mt-3 sm:py-3.5',
            'bg-[linear-gradient(120deg,#2E2390_0%,#4B3BD5_55%,#7C5CF0_100%)] shadow-[0_14px_30px_-18px_rgb(46_35_144/0.9)]',
            'transition-transform duration-base ease-out motion-safe:active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          )}
        >
          <span
            aria-hidden
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/15 ring-1 ring-inset ring-white/25"
          >
            <Spark className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-bold">{labels.whatsNewCardTitle}</span>
            <span className="mt-0.5 block text-xs text-white/75">{labels.whatsNewCardBody}</span>
          </span>
          <Glyph
            d={G.chevron}
            className="opacity-70 transition-transform duration-fast group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
          />
          <span
            aria-hidden
            className="aura-sheen pointer-events-none absolute inset-y-0 left-0 w-1/4 -translate-x-[160%] bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.22),transparent)]"
          />
        </button>
      )}

      <p
        className="aura-in mt-3 flex items-center justify-center gap-1.5 px-2 text-center text-2xs text-muted-foreground sm:mt-5"
        style={delay(560)}
      >
        <Glyph d={G.lock} className="h-3.5 w-3.5 opacity-70" />
        {labels.privacy}
      </p>
    </div>
  );
}
