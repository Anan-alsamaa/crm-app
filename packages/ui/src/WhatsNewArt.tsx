import type { CSSProperties, JSX } from 'react';
import { useMemo } from 'react';

/*
 * WHAT'S NEW — the pictures (owner, 2026-10-26: "more animations, they should
 * be engaged and love it, should feel special").
 *
 * Every slide gets a small drawing of the thing it talks about: a miniature of
 * the real screen, not decoration. They are plain SVG coloured by the theme
 * tokens (so dark mode and a tenant's brand colour carry through), animated by
 * the one stylesheet below.
 *
 * Motion rules, the same ones as the rest of the tour:
 *  - transform and opacity (and an SVG stroke offset) only: nothing animates
 *    layout, so a slide never makes the page reflow;
 *  - every rule is scoped to `[data-whats-new][data-motion="full"]`, and the
 *    un-animated styles ARE the finished picture, so reduced motion simply
 *    shows the last frame.
 *
 * The keyframe names are camelCase (`wnPop`) on purpose: the class names
 * `animate-wn-*` belong to the Tailwind preset, and the reduced-motion test
 * looks for exactly those.
 */

export type WhatsNewArtKind =
  | 'layout'
  | 'composer'
  | 'language'
  | 'dismiss'
  | 'coupon'
  | 'board'
  | 'reports'
  | 'alert'
  | 'kpi'
  | 'roles'
  | 'buttons'
  | 'description'
  | 'filters'
  | 'target'
  | 'celebrate';

/** A delay for the shared entrance classes. */
function d(ms: number): CSSProperties {
  return { '--d': `${ms}ms` } as CSSProperties;
}

const M = '[data-whats-new][data-motion="full"]';
const OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const SPRING = 'cubic-bezier(0.2, 0.9, 0.25, 1.15)';

export const WHATS_NEW_STYLES = `
/* Only what moves measures from its own box: an element positioned by its
   own transform attribute (a rotated tick, an arc) must keep the SVG default. */
[data-whats-new] .wn-art .wn-pop,[data-whats-new] .wn-art .wn-rise,[data-whats-new] .wn-art .wn-drop,[data-whats-new] .wn-art .wn-gx,[data-whats-new] .wn-art .wn-gy,[data-whats-new] .wn-art .wn-float,[data-whats-new] .wn-art .wn-ring,[data-whats-new] .wn-art .wn-twinkle,[data-whats-new] .wn-art .wn-knob,[data-whats-new] .wn-art .wn-flip,[data-whats-new] .wn-art .wn-l-row,[data-whats-new] .wn-art .wn-l-tab,[data-whats-new] .wn-art .wn-l-dismiss,[data-whats-new] .wn-art .wn-l-cursor,[data-whats-new] .wn-art .wn-l-ripple,[data-whats-new] .wn-art .wn-l-out,[data-whats-new] .wn-art .wn-l-in,[data-whats-new] .wn-art .wn-l-stamp,[data-whats-new] .wn-art .wn-l-press,[data-whats-new] .wn-art .wn-l-chip,[data-whats-new] .wn-art .wn-l-count{transform-box:fill-box}
[data-whats-new] .wn-oc{transform-origin:50% 50%}
[data-whats-new] .wn-os{transform-origin:0% 50%}
[data-whats-new] .wn-oe{transform-origin:100% 50%}
[data-whats-new] .wn-ob{transform-origin:50% 100%}
[data-whats-new] .wn-dash{stroke-dasharray:1 1;stroke-dashoffset:0}
[data-whats-new] .wn-knob{transform:translateX(24px)}
[data-whats-new] .wn-flip{transform:translateX(12px)}
[data-whats-new] .wn-l-out{transform:scaleX(0)}
[data-whats-new] .wn-l-ripple{opacity:0}
[data-whats-new] .wn-cta-sheen,[data-whats-new] .wn-badge-sheen{opacity:0}

@keyframes wnPop{0%{opacity:0;transform:scale(.4)}60%{opacity:1;transform:scale(1.08)}100%{opacity:1;transform:none}}
@keyframes wnRise{0%{opacity:0;transform:translateY(12px)}100%{opacity:1;transform:none}}
@keyframes wnDrop{0%{opacity:0;transform:translateY(-100%)}100%{opacity:1;transform:none}}
@keyframes wnGx{0%{transform:scaleX(0)}100%{transform:none}}
@keyframes wnGy{0%{transform:scaleY(0)}100%{transform:none}}
@keyframes wnDraw{0%{stroke-dashoffset:1;opacity:0}6%{opacity:1}100%{stroke-dashoffset:0;opacity:1}}
@keyframes wnFade{0%{opacity:0}100%{opacity:1}}
@keyframes wnFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes wnRing{0%{opacity:.55;transform:scale(1)}100%{opacity:0;transform:scale(1.9)}}
@keyframes wnTwinkle{0%,100%{opacity:.25;transform:scale(.6)}50%{opacity:1;transform:scale(1)}}
@keyframes wnBlink{0%,49%{opacity:1}50%,100%{opacity:0}}
@keyframes wnSpin{100%{transform:rotate(360deg)}}
@keyframes wnAuroraA{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(-70px,34px,0) scale(1.25)}}
@keyframes wnAuroraB{0%,100%{transform:translate3d(0,0,0) scale(1.1)}50%{transform:translate3d(80px,-20px,0) scale(.9)}}
@keyframes wnAuroraC{0%,100%{transform:translate3d(0,0,0) scale(.95)}50%{transform:translate3d(-30px,-30px,0) scale(1.2)}}
@keyframes wnWord{0%{opacity:0;transform:translateY(.55em)}100%{opacity:1;transform:none}}
@keyframes wnBadge{0%{opacity:0;transform:scale(.55) translateY(6px)}60%{opacity:1;transform:scale(1.07)}100%{opacity:1;transform:none}}
@keyframes wnOrb{0%{opacity:0;transform:scale(.3) rotate(-30deg)}65%{opacity:1;transform:scale(1.08) rotate(4deg)}100%{opacity:1;transform:none}}
@keyframes wnSheen{0%{transform:translateX(-140%) skewX(-20deg)}55%,100%{transform:translateX(360%) skewX(-20deg)}}
@keyframes wnNudge{0%,100%{transform:translateX(0)}50%{transform:translateX(3px)}}
@keyframes wnNudgeRtl{0%,100%{transform:scaleX(-1) translateX(0)}50%{transform:scaleX(-1) translateX(3px)}}
@keyframes wnConfetti{
  0%{opacity:0;transform:translate(0,0) rotate(0deg) scale(.4);animation-timing-function:cubic-bezier(.12,.75,.3,1)}
  8%{opacity:1}
  42%{transform:translate(var(--cx),var(--cy)) rotate(calc(var(--cr) * .45)) scale(1);animation-timing-function:cubic-bezier(.45,0,.9,.55)}
  80%{opacity:1}
  100%{opacity:0;transform:translate(calc(var(--cx) * 1.3),var(--cf)) rotate(var(--cr)) scale(.85)}
}
@keyframes wnRow{0%,28%{transform:translateY(0)}33%,61%{transform:translateY(17px)}66%,94%{transform:translateY(34px)}100%{transform:translateY(0)}}
@keyframes wnTab{0%,40%{transform:translateX(0)}50%,90%{transform:translateX(52px)}100%{transform:translateX(0)}}
@keyframes wnKnob{0%{transform:translateX(0)}100%{transform:translateX(24px)}}
@keyframes wnFlip{0%{transform:translateX(0)}100%{transform:translateX(12px)}}
@keyframes wnDismiss{0%,42%{opacity:1;transform:none}52%,82%{opacity:0;transform:scale(.9)}92%,100%{opacity:1;transform:none}}
@keyframes wnCursor{0%{opacity:0;transform:translate(70px,26px)}10%{opacity:1;transform:translate(70px,26px)}38%,72%{opacity:1;transform:translate(0,0)}84%,100%{opacity:0;transform:translate(0,0)}}
@keyframes wnRipple{0%,40%{opacity:0;transform:scale(.3)}44%{opacity:.75;transform:scale(.5)}62%,100%{opacity:0;transform:scale(1.7)}}
@keyframes wnSwapOut{0%,30%{transform:scaleX(1)}42%,88%{transform:scaleX(0)}100%{transform:scaleX(1)}}
@keyframes wnSwapIn{0%,36%{transform:scaleX(0)}50%,88%{transform:scaleX(1)}100%{transform:scaleX(0)}}
@keyframes wnStamp{0%,36%{opacity:0;transform:scale(.4)}46%{opacity:1;transform:scale(1.12)}52%,88%{opacity:1;transform:none}100%{opacity:0;transform:scale(.6)}}
@keyframes wnHeat{0%,25%{opacity:0}60%,100%{opacity:1}}
@keyframes wnPress{0%,40%{transform:none}46%{transform:scale(.92)}54%,100%{transform:none}}
@keyframes wnLight{0%,44%{opacity:0}52%,88%{opacity:1}98%,100%{opacity:0}}
@keyframes wnChip{0%,36%{opacity:0;transform:scale(.5)}46%{opacity:1;transform:scale(1.08)}52%,88%{opacity:1;transform:none}98%,100%{opacity:0;transform:scale(.6)}}
@keyframes wnCount{0%,52%{opacity:0;transform:scale(.4)}60%{opacity:1;transform:scale(1.15)}66%,88%{opacity:1;transform:none}98%,100%{opacity:0;transform:scale(.6)}}

${M} .wn-pop{animation:wnPop .56s ${SPRING} var(--d,0ms) both}
${M} .wn-rise{animation:wnRise .52s ${OUT} var(--d,0ms) both}
${M} .wn-drop{animation:wnDrop .5s ${OUT} var(--d,0ms) both}
${M} .wn-gx{animation:wnGx .62s ${OUT} var(--d,0ms) both}
${M} .wn-gy{animation:wnGy .7s ${OUT} var(--d,0ms) both}
${M} .wn-draw{animation:wnDraw 1.1s cubic-bezier(.65,0,.35,1) var(--d,0ms) both}
${M} .wn-fade{animation:wnFade .5s ${OUT} var(--d,0ms) both}
${M} .wn-float{animation:wnFloat 4.2s ease-in-out var(--d,0ms) infinite}
${M} .wn-ring{animation:wnRing 2.4s cubic-bezier(.2,.6,.35,1) var(--d,0ms) infinite}
${M} .wn-twinkle{animation:wnTwinkle 2.8s ease-in-out var(--d,0ms) infinite}
${M} .wn-blink{animation:wnBlink 1.05s steps(1) infinite}
${M} .wn-knob{animation:wnKnob .5s ${SPRING} var(--d,0ms) both}
${M} .wn-flip{animation:wnFlip .38s ${SPRING} var(--d,0ms) both}
${M} .wn-l-row{animation:wnRow 5.4s ${OUT} 1s infinite}
${M} .wn-l-tab{animation:wnTab 4.4s ${OUT} .9s infinite}
${M} .wn-l-dismiss{animation:wnDismiss 4.2s ${OUT} .6s infinite}
${M} .wn-l-cursor{animation:wnCursor 4.2s ${OUT} .6s infinite both}
${M} .wn-l-ripple{animation:wnRipple 4.2s ease-out .6s infinite}
${M} .wn-l-out{animation:wnSwapOut 4.6s ${OUT} .7s infinite both}
${M} .wn-l-in{animation:wnSwapIn 4.6s ${OUT} .7s infinite both}
${M} .wn-l-stamp{animation:wnStamp 4.6s ${OUT} .7s infinite both}
${M} .wn-l-heat{animation:wnHeat 2.6s ease-in-out var(--d,0ms) infinite alternate both}
${M} .wn-l-press{animation:wnPress 4.4s ${OUT} .8s infinite}
${M} .wn-l-light{animation:wnLight 4.4s ${OUT} .8s infinite both}
${M} .wn-l-chip{animation:wnChip 4.4s ${OUT} .8s infinite both}
${M} .wn-l-count{animation:wnCount 4.4s ${OUT} .8s infinite both}

${M} .wn-aurora-a{animation:wnAuroraA 14s ease-in-out infinite}
${M} .wn-aurora-b{animation:wnAuroraB 18s ease-in-out infinite}
${M} .wn-aurora-c{animation:wnAuroraC 16s ease-in-out infinite}
${M} .wn-orbit-1{animation:wnSpin 16s linear infinite}
${M} .wn-orbit-2{animation:wnSpin 26s linear infinite reverse}
${M} .wn-orb{animation:wnOrb .9s ${SPRING} .35s both}
${M} .wn-badge{animation:wnBadge .6s ${SPRING} .22s both}
${M} .wn-word{animation:wnWord .62s ${OUT} var(--d,0ms) both}
${M} .wn-sub{animation:wnRise .6s ${OUT} var(--d,0ms) both}
${M} .wn-badge-sheen{opacity:1;animation:wnSheen 3.6s ease-in-out 1s infinite}
${M} .wn-cta-sheen{opacity:1;animation:wnSheen 2.8s ease-in-out .5s infinite}
${M} .wn-cta-arrow{animation:wnNudge 1.4s ease-in-out infinite}
${M} [dir="rtl"] .wn-cta-arrow,${M}[dir="rtl"] .wn-cta-arrow{animation-name:wnNudgeRtl}
${M} .wn-confetti{animation:wnConfetti var(--ct,1.6s) linear var(--d,0ms) both}
[data-whats-new] .wn-confetti{opacity:0}
`;

/* ── The hero's moving sky ──────────────────────────────────────────────── */

/** Aurora, two orbits around a glowing mark, and a few twinkling stars. */
export function WhatsNewHeroBackdrop(): JSX.Element {
  const stars = [
    { top: '22%', start: '8%', size: 3, delay: 0 },
    { top: '64%', start: '18%', size: 2, delay: 900 },
    { top: '14%', start: '46%', size: 2, delay: 400 },
    { top: '38%', start: '58%', size: 3, delay: 1500 },
    { top: '78%', start: '52%', size: 2, delay: 2100 },
    { top: '30%', start: '30%', size: 2, delay: 1200 },
  ];
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <span className="wn-aurora-a absolute -end-[80px] -top-[120px] h-[340px] w-[340px] rounded-full bg-[radial-gradient(circle,rgb(124_108_255/0.85),rgb(75_59_213/0)_68%)] opacity-80" />
      <span className="wn-aurora-b absolute -bottom-[160px] -start-[90px] h-[360px] w-[360px] rounded-full bg-[radial-gradient(circle,rgb(75_59_213/0.75),rgb(75_59_213/0)_70%)]" />
      <span className="wn-aurora-c absolute -bottom-[120px] end-[22%] h-[260px] w-[260px] rounded-full bg-[radial-gradient(circle,rgb(196_120_255/0.45),rgb(196_120_255/0)_70%)]" />
      {stars.map((s, i) => (
        <span
          key={i}
          className="wn-twinkle absolute rounded-full bg-white"
          style={{
            top: s.top,
            insetInlineStart: s.start,
            width: s.size,
            height: s.size,
            ...d(s.delay),
          }}
        />
      ))}
      {/* The orbit system, on the end side of the header. */}
      <div className="absolute end-[26px] top-1/2 hidden h-[212px] w-[212px] -translate-y-1/2 sm:block">
        <div className="absolute inset-0 rounded-full border border-white/[0.10]" />
        <div className="absolute inset-[40px] rounded-full border border-white/[0.16]" />
        <div className="wn-orbit-2 absolute inset-0">
          <span className="absolute start-1/2 top-[-4px] h-2 w-2 -translate-x-1/2 rounded-full bg-[#c9c2ff] shadow-[0_0_12px_2px_rgb(160_148_255/0.8)]" />
          <span className="absolute bottom-[26px] end-[12px] h-1.5 w-1.5 rounded-full bg-white/70" />
        </div>
        <div className="wn-orbit-1 absolute inset-[40px]">
          <span className="absolute end-[-5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[#f3c969] shadow-[0_0_14px_3px_rgb(243_201_105/0.65)]" />
        </div>
        <div className="wn-orb absolute inset-[74px] grid place-items-center rounded-[22px] bg-[linear-gradient(145deg,rgb(255_255_255/0.22),rgb(255_255_255/0.06))] shadow-[0_18px_40px_-12px_rgb(10_8_40/0.8),inset_0_1px_0_rgb(255_255_255/0.35)] ring-1 ring-white/20">
          <svg
            viewBox="0 0 24 24"
            className="h-8 w-8 text-white"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3" opacity=".55" />
            <path
              d="M12 7.5l1.6 2.9 2.9 1.6-2.9 1.6L12 16.5l-1.6-2.9L7.5 12l2.9-1.6z"
              fill="currentColor"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}

/* ── Confetti, for the last step ────────────────────────────────────────── */

const CONFETTI_COLORS = [
  '#4B3BD5',
  '#7C6CFF',
  '#F3C969',
  '#B3A9FF',
  '#4B3BD5',
  '#FFFFFF',
  '#F3C969',
];

/** A deterministic 0..1 per (index, salt): the same burst every time. */
function noise(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A one-off burst from (x, y) inside the panel. Each piece flies up and out
 * on a fan, then falls and fades: two transform legs in one keyframe.
 */
export function WhatsNewConfetti({ x, y }: { x: number; y: number }): JSX.Element {
  const pieces = useMemo(
    () =>
      Array.from({ length: 44 }, (_, i) => {
        const angle = (-165 + noise(i, 1) * 150) * (Math.PI / 180);
        const speed = 110 + noise(i, 2) * 190;
        const cx = Math.cos(angle) * speed;
        const cy = Math.sin(angle) * speed;
        const shape = i % 3;
        return {
          key: i,
          color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
          w: shape === 0 ? 7 : shape === 1 ? 6 : 4,
          h: shape === 0 ? 11 : shape === 1 ? 6 : 13,
          round: shape === 1,
          style: {
            '--cx': `${cx.toFixed(1)}px`,
            '--cy': `${cy.toFixed(1)}px`,
            '--cf': `${(cy + 170 + noise(i, 3) * 140).toFixed(1)}px`,
            '--cr': `${Math.round((noise(i, 4) > 0.5 ? 1 : -1) * (360 + noise(i, 5) * 540))}deg`,
            '--ct': `${Math.round(1500 + noise(i, 6) * 700)}ms`,
            '--d': `${Math.round(noise(i, 7) * 140)}ms`,
          } as CSSProperties,
        };
      }),
    [],
  );
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {pieces.map((p) => (
        <span
          key={p.key}
          className="wn-confetti absolute"
          style={{
            left: x - p.w / 2,
            top: y - p.h / 2,
            width: p.w,
            height: p.h,
            background: p.color,
            borderRadius: p.round ? 999 : 1.5,
            boxShadow: p.color === '#FFFFFF' ? '0 0 0 1px rgb(75 59 213 / 0.25)' : undefined,
            ...p.style,
          }}
        />
      ))}
    </div>
  );
}

/* ── The slide pictures ─────────────────────────────────────────────────── */

const card = 'fill-card stroke-foreground/[0.10]';
const line = 'fill-foreground/[0.12]';
const soft = 'fill-primary/[0.14]';

/** A small app window: the frame most of the pictures sit in. */
function Window({ dark = false }: { dark?: boolean }) {
  return (
    <>
      <rect x="22" y="22" width="200" height="126" rx="16" className="fill-primary/[0.10]" />
      <rect
        x="18"
        y="16"
        width="204"
        height="128"
        rx="16"
        className={dark ? 'fill-ink' : card}
        strokeWidth="1"
      />
    </>
  );
}

function Spark({ x, y, s = 1, delay = 0 }: { x: number; y: number; s?: number; delay?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <path
        className="wn-twinkle wn-oc fill-primary"
        style={d(delay)}
        d="M0 -7 L1.8 -1.8 L7 0 L1.8 1.8 L0 7 L-1.8 1.8 L-7 0 L-1.8 -1.8 Z"
      />
    </g>
  );
}

function Check({ x, y, r = 11, delay = 0 }: { x: number; y: number; r?: number; delay?: number }) {
  return (
    <g className="wn-pop wn-oc" style={d(delay)}>
      <circle cx={x} cy={y} r={r} className="fill-success" />
      <path
        pathLength={1}
        className="wn-dash wn-draw stroke-white"
        style={d(delay + 220)}
        d={`M${x - r * 0.42} ${y + 0.5} l${r * 0.3} ${r * 0.3} l${r * 0.55} -${r * 0.62}`}
        fill="none"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

function ArtLayout() {
  return (
    <>
      <Window />
      <path
        className="wn-drop fill-ink"
        style={d(80)}
        d="M18 32a16 16 0 0 1 16-16h172a16 16 0 0 1 16 16v4H18z"
      />
      <g className="wn-fade" style={d(380)}>
        <rect x="30" y="23" width="16" height="6" rx="3" className="fill-white/70" />
        <rect x="56" y="23" width="26" height="6" rx="3" className="fill-primary" />
        <rect x="88" y="23" width="22" height="6" rx="3" className="fill-white/25" />
        <rect x="116" y="23" width="24" height="6" rx="3" className="fill-white/25" />
        <circle cx="206" cy="26" r="4" className="fill-white/40" />
      </g>
      {/* The list, and a selection that walks down it. */}
      <g className="wn-l-row">
        <rect
          x="26"
          y="45"
          width="78"
          height="14"
          rx="7"
          className="wn-fade fill-primary/[0.16]"
          style={d(700)}
        />
      </g>
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          <circle
            cx="36"
            cy={52 + i * 17}
            r="3.5"
            className={`wn-pop wn-oc ${i === 0 ? 'fill-primary' : 'fill-foreground/20'}`}
            style={d(260 + i * 70)}
          />
          <rect
            x="44"
            y={49 + i * 17}
            width={50 - (i % 2) * 14}
            height="6"
            rx="3"
            className={`wn-gx wn-os ${line}`}
            style={d(300 + i * 70)}
          />
        </g>
      ))}
      <rect
        x="112"
        y="44"
        width="100"
        height="90"
        rx="10"
        className="wn-rise fill-primary/[0.06]"
        style={d(420)}
      />
      <rect
        x="122"
        y="54"
        width="54"
        height="8"
        rx="4"
        className="wn-gx wn-os fill-foreground/25"
        style={d(560)}
      />
      <rect
        x="122"
        y="70"
        width="80"
        height="5"
        rx="2.5"
        className={`wn-gx wn-os ${line}`}
        style={d(640)}
      />
      <rect
        x="122"
        y="81"
        width="68"
        height="5"
        rx="2.5"
        className={`wn-gx wn-os ${line}`}
        style={d(700)}
      />
      <rect
        x="122"
        y="100"
        width="80"
        height="24"
        rx="8"
        className={`wn-pop wn-oc ${soft}`}
        style={d(820)}
      />
      <Spark x={204} y={148} s={0.9} delay={600} />
    </>
  );
}

function ArtComposer() {
  return (
    <>
      <rect
        x="26"
        y="10"
        width="120"
        height="22"
        rx="11"
        className="wn-rise fill-foreground/[0.06]"
        style={d(80)}
      />
      <rect
        x="36"
        y="18"
        width="70"
        height="6"
        rx="3"
        className={`wn-gx wn-os ${line}`}
        style={d(200)}
      />
      <rect x="22" y="38" width="200" height="110" rx="18" className="fill-primary/[0.10]" />
      <rect x="18" y="34" width="204" height="110" rx="18" className={card} />
      {/* Reply | Internal note, one row, with a sliding marker. */}
      <rect x="30" y="46" width="108" height="22" rx="11" className="fill-foreground/[0.06]" />
      <g className="wn-l-tab">
        <rect
          x="33"
          y="49"
          width="50"
          height="16"
          rx="8"
          className="wn-pop wn-oc fill-primary"
          style={d(240)}
        />
      </g>
      <rect x="45" y="55" width="26" height="4" rx="2" className="fill-white/90" />
      <rect x="97" y="55" width="28" height="4" rx="2" className="fill-foreground/30" />
      {/* Typing. */}
      <rect
        x="30"
        y="80"
        width="132"
        height="6"
        rx="3"
        className={`wn-gx wn-os ${line}`}
        style={d(380)}
      />
      <rect
        x="30"
        y="93"
        width="84"
        height="6"
        rx="3"
        className={`wn-gx wn-os ${line}`}
        style={d(520)}
      />
      <rect x="118" y="91" width="2" height="10" rx="1" className="wn-blink fill-primary" />
      {/* Quick replies, Enhance, AI — and send. */}
      {[0, 1, 2].map((i) => (
        <g key={i} className="wn-pop wn-oc" style={d(640 + i * 90)}>
          <rect
            x={30 + i * 44}
            y="114"
            width="38"
            height="18"
            rx="9"
            className={i === 2 ? 'fill-primary/20' : 'fill-foreground/[0.07]'}
          />
          {i === 0 && (
            <path
              d="M40 120h18M40 125h12"
              className="stroke-foreground/40"
              strokeWidth="2"
              strokeLinecap="round"
            />
          )}
          {i === 1 && (
            <path
              d="M85 128l8-8M92 119l3 3"
              className="stroke-foreground/40"
              strokeWidth="2"
              strokeLinecap="round"
            />
          )}
          {i === 2 && (
            <path
              d="M127 117l1.6 3.4 3.4 1.6-3.4 1.6-1.6 3.4-1.6-3.4-3.4-1.6 3.4-1.6z"
              className="fill-primary"
            />
          )}
        </g>
      ))}
      <g className="wn-pop wn-oc" style={d(960)}>
        <circle cx="202" cy="123" r="12" className="fill-primary" />
        <path
          d="M197 123h9m-3.5-4 4 4-4 4"
          className="stroke-white"
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <circle
        cx="202"
        cy="123"
        r="12"
        className="wn-ring wn-oc fill-none stroke-primary/50"
        strokeWidth="2"
        style={d(1500)}
      />
    </>
  );
}

function ArtLanguage() {
  return (
    <>
      {/* The customer, in Arabic. */}
      <g className="wn-rise" style={d(80)}>
        <path
          d="M24 30a14 14 0 0 1 14-14h92a14 14 0 0 1 14 14v12a14 14 0 0 1-14 14H44l-12 8v-9a14 14 0 0 1-8-13z"
          className="fill-foreground/[0.07]"
        />
        <rect
          x="58"
          y="28"
          width="74"
          height="5"
          rx="2.5"
          className={`wn-gx wn-oe ${line}`}
          style={d(260)}
        />
        <rect
          x="78"
          y="39"
          width="54"
          height="5"
          rx="2.5"
          className={`wn-gx wn-oe ${line}`}
          style={d(340)}
        />
      </g>
      {/* The language switch flips to Arabic... */}
      <g className="wn-pop wn-oc" style={d(380)}>
        <rect
          x="22"
          y="110"
          width="58"
          height="28"
          rx="14"
          className="fill-card stroke-foreground/[0.12]"
        />
        <g className="wn-knob" style={d(800)}>
          <circle cx="37" cy="124" r="10" className="fill-primary" />
        </g>
        <text
          x="37"
          y="128"
          textAnchor="middle"
          className="fill-foreground/40 text-[10px] font-bold"
        >
          EN
        </text>
        <text x="61" y="129" textAnchor="middle" className="fill-white text-[13px] font-bold">
          ع
        </text>
      </g>
      {/* ...and the AI answers in it, written right to left. */}
      <g className="wn-pop" style={{ ...d(1050), transformOrigin: '0% 100%' }}>
        <path
          d="M96 80a14 14 0 0 1 14-14h92a14 14 0 0 1 14 14v28a14 14 0 0 1-14 14h-80l-14 9v-10a14 14 0 0 1-12-13z"
          className="fill-primary"
        />
      </g>
      <rect
        x="128"
        y="80"
        width="74"
        height="5"
        rx="2.5"
        className="wn-gx wn-oe fill-white/90"
        style={d(1300)}
      />
      <rect
        x="112"
        y="92"
        width="90"
        height="5"
        rx="2.5"
        className="wn-gx wn-oe fill-white/60"
        style={d(1420)}
      />
      <rect
        x="146"
        y="104"
        width="56"
        height="5"
        rx="2.5"
        className="wn-gx wn-oe fill-white/60"
        style={d(1540)}
      />
      <g className="wn-pop wn-oc" style={d(1250)}>
        <circle cx="212" cy="66" r="11" className="fill-card stroke-primary/30" />
        <path
          d="M212 59.5l1.7 4.3 4.3 1.7-4.3 1.7-1.7 4.3-1.7-4.3-4.3-1.7 4.3-1.7z"
          className="fill-primary"
        />
      </g>
      <Spark x={198} y={20} s={0.8} delay={300} />
      <Spark x={92} y={138} s={0.6} delay={1400} />
    </>
  );
}

function ArtDismiss() {
  return (
    <>
      <Window />
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x="32"
          y={34 + i * 16}
          width={56 - (i % 2) * 18}
          height="6"
          rx="3"
          className={`wn-gx wn-os ${line}`}
          style={d(120 + i * 60)}
        />
      ))}
      {/* The open panel that closes when you click outside it. */}
      <g className="wn-l-dismiss wn-oc">
        <g className="wn-pop wn-oc" style={d(300)}>
          <rect
            x="108"
            y="30"
            width="102"
            height="78"
            rx="12"
            className="fill-card stroke-primary/30"
            strokeWidth="1.2"
          />
          <rect x="118" y="42" width="44" height="7" rx="3.5" className="fill-primary/70" />
          {[0, 1, 2].map((i) => (
            <rect
              key={i}
              x="118"
              y={58 + i * 14}
              width={78 - i * 12}
              height="8"
              rx="4"
              className="fill-foreground/[0.08]"
            />
          ))}
        </g>
      </g>
      {/* Click outside. */}
      <circle cx="60" cy="116" r="16" className="wn-l-ripple wn-oc fill-primary/25" />
      <g className="wn-l-cursor">
        <path
          d="M58 110l0 20 5-5 4 9 4-2-4-9 7 0z"
          className="fill-ink stroke-white"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </g>
      {/* ...or press Esc. */}
      <g className="wn-pop wn-oc" style={d(520)}>
        <rect
          x="160"
          y="116"
          width="44"
          height="22"
          rx="7"
          className="fill-card stroke-foreground/20"
        />
        <rect x="160" y="134" width="44" height="4" rx="2" className="fill-foreground/10" />
        <text
          x="182"
          y="131"
          textAnchor="middle"
          className="fill-foreground/70 text-[10px] font-bold"
        >
          Esc
        </text>
      </g>
    </>
  );
}

function ArtCoupon() {
  return (
    <>
      <Window />
      <circle cx="40" cy="38" r="9" className={`wn-pop wn-oc ${soft}`} style={d(100)} />
      <rect
        x="56"
        y="32"
        width="70"
        height="6"
        rx="3"
        className="wn-gx wn-os fill-foreground/25"
        style={d(200)}
      />
      <rect
        x="56"
        y="43"
        width="46"
        height="5"
        rx="2.5"
        className={`wn-gx wn-os ${line}`}
        style={d(260)}
      />
      <rect
        x="160"
        y="31"
        width="46"
        height="16"
        rx="8"
        className="wn-pop wn-oc fill-warning/20"
        style={d(320)}
      />
      {/* The coupon, perforated, sliding onto the ticket. */}
      <g className="wn-float" style={d(1400)}>
        <g className="wn-rise" style={d(420)}>
          <path
            d="M34 70h152a6 6 0 0 1 6 6v8a8 8 0 0 0 0 16v8a6 6 0 0 1-6 6H34a6 6 0 0 1-6-6v-8a8 8 0 0 0 0-16v-8a6 6 0 0 1 6-6z"
            className="fill-primary"
          />
          <path
            className="wn-fade stroke-white/50"
            style={d(800)}
            d="M150 76v32"
            fill="none"
            strokeWidth="1.6"
            strokeDasharray="3 3"
          />
          <text x="168" y="98" textAnchor="middle" className="fill-white text-[18px] font-bold">
            %
          </text>
          <rect x="44" y="82" width="70" height="7" rx="3.5" className="fill-white/90" />
          <rect x="44" y="95" width="46" height="5" rx="2.5" className="fill-white/50" />
        </g>
      </g>
      <Check x={192} y={68} delay={1000} />
      <Spark x={30} y={132} s={0.7} delay={800} />
    </>
  );
}

function ArtBoard() {
  const tiles = [
    { x: 30, y: 30, time: '42:10', heat: 'fill-destructive', base: 'fill-warning', delay: 0 },
    { x: 124, y: 30, time: '31:05', heat: 'fill-destructive', base: 'fill-warning', delay: 900 },
    { x: 30, y: 84, time: '24:48', heat: 'fill-warning', base: 'fill-warning/50', delay: 400 },
    { x: 124, y: 84, time: '18:02', heat: 'fill-warning/60', base: 'fill-white/10', delay: 1400 },
  ];
  return (
    <>
      <Window dark />
      {tiles.map((t, i) => (
        <g key={i} className="wn-pop wn-oc" style={d(160 + i * 110)}>
          <rect x={t.x} y={t.y} width="86" height="46" rx="9" className={t.base} />
          <rect
            x={t.x}
            y={t.y}
            width="86"
            height="46"
            rx="9"
            className={`wn-l-heat ${t.heat}`}
            style={d(t.delay)}
          />
          <text
            x={t.x + 43}
            y={t.y + 29}
            textAnchor="middle"
            className="fill-white text-[17px] font-bold tabular-nums"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {t.time}
          </text>
        </g>
      ))}
      <circle cx="206" cy="24" r="3" className="fill-destructive" />
      <circle cx="206" cy="24" r="3" className="wn-ring wn-oc fill-destructive" />
    </>
  );
}

function ArtReports() {
  const bars = [30, 44, 26, 52, 38, 60, 46, 34];
  return (
    <>
      {[0, 1, 2].map((i) => (
        <g key={i} className="wn-rise" style={d(80 + i * 90)}>
          <rect
            x={18 + i * 70}
            y="14"
            width="62"
            height="40"
            rx="10"
            className={i === 0 ? 'fill-primary' : card}
          />
          <rect
            x={28 + i * 70}
            y="24"
            width="26"
            height="8"
            rx="4"
            className={i === 0 ? 'fill-white' : 'fill-foreground/30'}
          />
          <rect
            x={28 + i * 70}
            y="38"
            width="38"
            height="5"
            rx="2.5"
            className={i === 0 ? 'fill-white/50' : line}
          />
        </g>
      ))}
      <rect
        x="18"
        y="62"
        width="204"
        height="84"
        rx="14"
        className={`wn-rise ${card}`}
        style={d(300)}
      />
      {bars.map((h, i) => (
        <rect
          key={i}
          x={34 + i * 23}
          y={134 - h}
          width="13"
          height={h}
          rx="4"
          className={`wn-gy wn-ob ${i === 5 ? 'fill-primary' : 'fill-primary/25'}`}
          style={d(420 + i * 70)}
        />
      ))}
      <Spark x={181} y={64} s={0.8} delay={1100} />
    </>
  );
}

function ArtAlert() {
  return (
    <>
      <rect x="30" y="40" width="186" height="80" rx="16" className="fill-primary/[0.10]" />
      <g className="wn-rise" style={d(80)}>
        <rect x="24" y="32" width="188" height="80" rx="16" className={card} />
        <circle cx="50" cy="58" r="12" className={soft} />
        <rect x="70" y="50" width="64" height="7" rx="3.5" className="fill-foreground/30" />
        <rect x="70" y="64" width="112" height="6" rx="3" className={line} />
        {/* The message as first sent, then as edited. */}
        <rect
          x="70"
          y="78"
          width="90"
          height="6"
          rx="3"
          className="wn-l-out wn-os fill-foreground/20"
        />
        <rect
          x="70"
          y="78"
          width="118"
          height="6"
          rx="3"
          className="wn-l-in wn-os fill-primary/70"
        />
        <rect x="70" y="92" width="44" height="6" rx="3" className={line} />
      </g>
      {/* "edited" — and the bell stays quiet. */}
      <g className="wn-l-stamp wn-oc">
        <rect x="152" y="88" width="48" height="16" rx="8" className="fill-primary/15" />
        <path d="M160 100l1-3 6-6 2 2-6 6z" className="fill-primary" />
        <rect x="173" y="94" width="20" height="4" rx="2" className="fill-primary/70" />
      </g>
      <g className="wn-pop wn-oc" style={d(300)}>
        <circle cx="206" cy="30" r="16" className="fill-card stroke-foreground/[0.12]" />
        <path
          d="M200 34h12l-1.6-2.2v-4.3a4.4 4.4 0 0 0-8.8 0v4.3z M204.5 36.5a1.6 1.6 0 0 0 3 0"
          className="fill-foreground/50"
        />
        <path
          pathLength={1}
          className="wn-dash wn-draw stroke-destructive"
          style={d(700)}
          d="M197 21l18 18"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </g>
      <Spark x={30} y={140} s={0.7} delay={500} />
    </>
  );
}

function ArtKpi() {
  return (
    <>
      <rect
        x="18"
        y="16"
        width="96"
        height="128"
        rx="16"
        className={`wn-rise ${card}`}
        style={d(60)}
      />
      <circle
        cx="66"
        cy="70"
        r="30"
        className="fill-none stroke-foreground/[0.08]"
        strokeWidth="11"
      />
      <circle
        cx="66"
        cy="70"
        r="30"
        pathLength={1}
        className="wn-dash wn-draw fill-none stroke-primary"
        strokeWidth="11"
        strokeLinecap="round"
        transform="rotate(-90 66 70)"
        style={{ ...d(300), strokeDasharray: '0.72 1' }}
      />
      <rect
        x="54"
        y="66"
        width="24"
        height="8"
        rx="4"
        className="wn-pop wn-oc fill-foreground/40"
        style={d(900)}
      />
      <rect
        x="34"
        y="114"
        width="64"
        height="6"
        rx="3"
        className={`wn-gx wn-os ${line}`}
        style={d(500)}
      />
      <rect
        x="34"
        y="126"
        width="44"
        height="6"
        rx="3"
        className={`wn-gx wn-os ${line}`}
        style={d(560)}
      />
      <rect
        x="122"
        y="16"
        width="100"
        height="62"
        rx="16"
        className={`wn-rise ${card}`}
        style={d(160)}
      />
      <path
        pathLength={1}
        className="wn-dash wn-draw fill-none stroke-primary"
        style={d(500)}
        d="M132 64l14-10 12 6 14-16 12 8 16-18"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="200" cy="34" r="4.5" className="wn-pop wn-oc fill-primary" style={d(1450)} />
      <circle cx="200" cy="34" r="4.5" className="wn-ring wn-oc fill-primary/60" style={d(1700)} />
      <rect
        x="122"
        y="86"
        width="100"
        height="58"
        rx="16"
        className={`wn-rise ${card}`}
        style={d(260)}
      />
      <rect
        x="134"
        y="98"
        width="70"
        height="7"
        rx="3.5"
        className="wn-gx wn-os fill-primary/70"
        style={d(700)}
      />
      <rect
        x="134"
        y="112"
        width="48"
        height="7"
        rx="3.5"
        className="wn-gx wn-os fill-primary/35"
        style={d(780)}
      />
      <rect
        x="134"
        y="126"
        width="22"
        height="7"
        rx="3.5"
        className="wn-gx wn-os fill-warning"
        style={d(860)}
      />
    </>
  );
}

function ArtRoles() {
  return (
    <>
      <Window />
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x="28"
          y={30 + i * 22}
          width="60"
          height="16"
          rx="8"
          className={`wn-pop wn-oc ${i === 0 ? 'fill-primary' : 'fill-foreground/[0.07]'}`}
          style={d(100 + i * 80)}
        />
      ))}
      <rect x="98" y="26" width="1" height="108" className="fill-foreground/10" />
      {[0, 1, 2, 3].map((i) => {
        const on = i !== 2;
        return (
          <g key={i} className="wn-rise" style={d(260 + i * 80)}>
            <rect
              x="110"
              y={34 + i * 22}
              width={58 - (i % 2) * 14}
              height="6"
              rx="3"
              className={line}
            />
            <rect
              x="180"
              y={29 + i * 22}
              width="30"
              height="16"
              rx="8"
              className="fill-foreground/15"
            />
            {on && (
              <rect
                x="180"
                y={29 + i * 22}
                width="30"
                height="16"
                rx="8"
                className="wn-fade fill-primary"
                style={d(700 + i * 220)}
              />
            )}
            <g className={on ? 'wn-flip' : undefined} style={d(700 + i * 220)}>
              <circle cx="188" cy={37 + i * 22} r="6" className="fill-white" />
            </g>
          </g>
        );
      })}
      <rect
        x="120"
        y="118"
        width="40"
        height="16"
        rx="8"
        className="wn-pop wn-oc fill-destructive/15"
        style={d(1300)}
      />
      <rect
        x="166"
        y="118"
        width="44"
        height="16"
        rx="8"
        className="wn-pop wn-oc fill-primary"
        style={d(1400)}
      />
    </>
  );
}

function ArtButtons() {
  return (
    <>
      <Window />
      {/* Filled pills you can press, and one you clearly cannot. */}
      <g className="wn-pop wn-oc" style={d(120)}>
        <g className="wn-l-press wn-oc">
          <rect x="34" y="40" width="74" height="26" rx="13" className="fill-primary" />
          <rect x="50" y="50" width="42" height="6" rx="3" className="fill-white/90" />
        </g>
      </g>
      <g className="wn-pop wn-oc" style={d(220)}>
        <rect x="118" y="40" width="88" height="26" rx="13" className="fill-primary/15" />
        <rect x="136" y="50" width="52" height="6" rx="3" className="fill-primary/80" />
      </g>
      <g className="wn-pop wn-oc" style={d(320)}>
        <rect x="34" y="80" width="80" height="26" rx="13" className="fill-foreground/[0.05]" />
        <rect x="52" y="90" width="44" height="6" rx="3" className="fill-foreground/15" />
      </g>
      <circle cx="80" cy="56" r="14" className="wn-l-ripple wn-oc fill-white/50" />
      <g className="wn-l-cursor">
        <path
          d="M78 52l0 20 5-5 4 9 4-2-4-9 7 0z"
          className="fill-ink stroke-white"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </g>
      <rect
        x="124"
        y="84"
        width="72"
        height="6"
        rx="3"
        className={`wn-gx wn-os ${line}`}
        style={d(420)}
      />
      <rect
        x="124"
        y="96"
        width="50"
        height="6"
        rx="3"
        className={`wn-gx wn-os ${line}`}
        style={d(480)}
      />
      <rect
        x="34"
        y="118"
        width="172"
        height="14"
        rx="7"
        className={`wn-gx wn-os fill-foreground/[0.05]`}
        style={d(520)}
      />
    </>
  );
}

function ArtDescription() {
  const lines = [
    { y: 64, w: 150 },
    { y: 76, w: 120 },
    { y: 96, w: 140 },
    { y: 108, w: 84 },
  ];
  return (
    <>
      <Window />
      <circle cx="40" cy="36" r="10" className={`wn-pop wn-oc ${soft}`} style={d(80)} />
      <rect
        x="58"
        y="30"
        width="58"
        height="6"
        rx="3"
        className="wn-gx wn-os fill-foreground/30"
        style={d(160)}
      />
      <rect
        x="58"
        y="40"
        width="36"
        height="5"
        rx="2.5"
        className={`wn-gx wn-os ${line}`}
        style={d(200)}
      />
      <g className="wn-pop wn-oc" style={d(320)}>
        <rect x="30" y="50" width="62" height="9" rx="4.5" className="fill-primary/15" />
        <rect x="37" y="53" width="48" height="3" rx="1.5" className="fill-primary" />
      </g>
      {lines.map((l, i) => (
        <rect
          key={i}
          x="30"
          y={l.y + 2}
          width={l.w}
          height="6"
          rx="3"
          className={`wn-gx wn-os ${line}`}
          style={d(480 + i * 170)}
        />
      ))}
      <g className="wn-pop wn-oc" style={d(1250)}>
        <rect x="122" y="120" width="40" height="16" rx="8" className="fill-foreground/[0.07]" />
        <rect x="168" y="120" width="44" height="16" rx="8" className="fill-success" />
      </g>
      <Spark x={204} y={40} s={0.8} delay={700} />
    </>
  );
}

function ArtFilters() {
  return (
    <>
      <Window />
      {[0, 1].map((i) => (
        <g key={i} className="wn-pop wn-oc" style={d(100 + i * 90)}>
          <rect
            x={28 + i * 66}
            y="28"
            width="58"
            height="22"
            rx="11"
            className="fill-foreground/[0.06]"
          />
          <rect
            x={38 + i * 66}
            y="37"
            width="28"
            height="4"
            rx="2"
            className="fill-foreground/30"
          />
          <path
            d={`M${72 + i * 66} 37l3 3 3-3`}
            className="stroke-foreground/40"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </g>
      ))}
      {/* A filter goes on, and Clear lights up with it. */}
      <g className="wn-l-chip wn-oc">
        <rect x="28" y="58" width="74" height="18" rx="9" className="fill-primary/15" />
        <rect x="36" y="65" width="44" height="4" rx="2" className="fill-primary" />
        <path
          d="M88 63l6 6m0-6-6 6"
          className="stroke-primary"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </g>
      <rect x="160" y="28" width="48" height="22" rx="11" className="fill-foreground/[0.05]" />
      <rect x="160" y="28" width="48" height="22" rx="11" className="wn-l-light fill-primary/15" />
      <rect x="172" y="37" width="24" height="4" rx="2" className="fill-foreground/25" />
      <rect x="172" y="37" width="24" height="4" rx="2" className="wn-l-light fill-primary" />
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x="28"
          y={88 + i * 14}
          width={150 - i * 22}
          height="6"
          rx="3"
          className={`wn-gx wn-os ${line}`}
          style={d(300 + i * 80)}
        />
      ))}
      {/* Export says how many rows it will download. */}
      <g className="wn-pop wn-oc" style={d(560)}>
        <rect x="150" y="114" width="62" height="22" rx="11" className="fill-ink" />
        <path
          d="M164 120v8m-3-3 3 3 3-3"
          className="stroke-white"
          fill="none"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="174" y="123" width="26" height="4" rx="2" className="fill-white/80" />
      </g>
      <g className="wn-l-count wn-oc">
        <rect x="190" y="102" width="30" height="16" rx="8" className="fill-primary" />
        <text x="205" y="114" textAnchor="middle" className="fill-white text-[9px] font-bold">
          128
        </text>
      </g>
    </>
  );
}

function ArtTarget() {
  const ticks = Array.from({ length: 12 }, (_, i) => i);
  return (
    <>
      <rect
        x="112"
        y="18"
        width="16"
        height="10"
        rx="3"
        className="wn-drop fill-foreground/30"
        style={d(80)}
      />
      <circle
        cx="120"
        cy="86"
        r="54"
        className="wn-pop wn-oc fill-card stroke-foreground/[0.10]"
        style={d(60)}
      />
      {ticks.map((i) => (
        <rect
          key={i}
          x="119"
          y="38"
          width="2"
          height={i % 3 === 0 ? 7 : 4}
          rx="1"
          className="wn-fade fill-foreground/25"
          transform={`rotate(${i * 30} 120 86)`}
          style={d(200 + i * 30)}
        />
      ))}
      <circle
        cx="120"
        cy="86"
        r="40"
        className="fill-none stroke-foreground/[0.07]"
        strokeWidth="8"
      />
      <circle
        cx="120"
        cy="86"
        r="40"
        pathLength={1}
        className="wn-dash wn-draw fill-none stroke-primary"
        strokeWidth="8"
        strokeLinecap="round"
        transform="rotate(-90 120 86)"
        style={{ ...d(400), strokeDasharray: '0.42 1' }}
      />
      <text
        x="120"
        y="94"
        textAnchor="middle"
        className="wn-pop wn-oc fill-foreground text-[22px] font-bold"
        style={d(700)}
      >
        5:00
      </text>
      <Check x={164} y={46} r={12} delay={1300} />
      <Spark x={52} y={40} s={0.8} delay={300} />
      <Spark x={196} y={132} s={0.6} delay={1100} />
    </>
  );
}

function ArtCelebrate() {
  const rays = Array.from({ length: 10 }, (_, i) => i);
  return (
    <>
      {rays.map((i) => (
        <g key={i} transform={`rotate(${i * 36} 120 80)`}>
          <rect
            x="118.5"
            y="14"
            width="3"
            height="14"
            rx="1.5"
            className="wn-pop wn-ob fill-primary/40"
            style={d(500 + (i % 2) * 80)}
          />
        </g>
      ))}
      <circle cx="120" cy="80" r="40" className="wn-ring wn-oc fill-primary/25" style={d(900)} />
      <circle cx="120" cy="80" r="40" className="wn-ring wn-oc fill-primary/20" style={d(2100)} />
      <g className="wn-pop wn-oc" style={d(120)}>
        <circle cx="120" cy="80" r="40" className="fill-primary" />
        <circle cx="120" cy="80" r="40" className="fill-none stroke-white/25" strokeWidth="1.5" />
        <circle cx="120" cy="80" r="31" className="fill-none stroke-white/20" strokeWidth="1" />
      </g>
      <path
        pathLength={1}
        className="wn-dash wn-draw stroke-white"
        style={d(450)}
        d="M103 81l11 11 23-24"
        fill="none"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Spark x={52} y={44} s={1.1} delay={200} />
      <Spark x={190} y={36} s={0.9} delay={900} />
      <Spark x={196} y={124} s={1.2} delay={500} />
      <Spark x={44} y={122} s={0.8} delay={1300} />
      <circle cx="74" cy="22" r="3" className="wn-twinkle wn-oc fill-[#F3C969]" style={d(700)} />
      <circle cx="170" cy="146" r="3" className="wn-twinkle wn-oc fill-[#F3C969]" style={d(1500)} />
    </>
  );
}

const ART: Record<WhatsNewArtKind, () => JSX.Element> = {
  layout: ArtLayout,
  composer: ArtComposer,
  language: ArtLanguage,
  dismiss: ArtDismiss,
  coupon: ArtCoupon,
  board: ArtBoard,
  reports: ArtReports,
  alert: ArtAlert,
  kpi: ArtKpi,
  roles: ArtRoles,
  buttons: ArtButtons,
  description: ArtDescription,
  filters: ArtFilters,
  target: ArtTarget,
  celebrate: ArtCelebrate,
};

/** One slide's picture, drawn in a 240×160 box that scales to its frame. */
export function WhatsNewArt({ kind }: { kind: WhatsNewArtKind }): JSX.Element {
  const Draw = ART[kind] ?? ArtCelebrate;
  return (
    <svg
      viewBox="0 0 240 160"
      aria-hidden
      focusable="false"
      className="wn-art block h-full w-full overflow-visible"
      style={{ direction: 'ltr' }}
    >
      <Draw />
    </svg>
  );
}
