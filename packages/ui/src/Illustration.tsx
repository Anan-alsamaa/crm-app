import type { JSX, SVGAttributes } from 'react';
import { cn } from './cn.js';

/*
 * In-house illustrations for empty states and brand surfaces. Single-line
 * stroke + a soft fill in the primary/secondary brand tones. Deliberately
 * small (180×180) so they sit inside a card or empty pane without dominating.
 *
 * Two-tone palette: stroke uses `currentColor` (caller sets text-foreground
 * or text-display), fill uses the primary or secondary brand at low alpha.
 */

export type IllustrationProps = SVGAttributes<SVGSVGElement> & { size?: number };

function base(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 200 200',
    fill: 'none',
    'aria-hidden': true as const,
    className: cn('shrink-0', className),
  };
}

/** A speech bubble landing in an inbox — for the inbox empty state. */
export function InboxEmptyArt({ size = 200, className, ...rest }: IllustrationProps): JSX.Element {
  return (
    <svg {...base(size, className)} {...rest}>
      {/* Soft halo */}
      <circle cx="100" cy="100" r="78" fill="oklch(var(--primary) / 0.08)" />
      {/* Speech bubble (primary fill) */}
      <path
        d="M52 70a14 14 0 0 1 14-14h54a14 14 0 0 1 14 14v36a14 14 0 0 1-14 14H88l-16 14v-14h-6a14 14 0 0 1-14-14V70Z"
        fill="oklch(var(--primary) / 0.16)"
        stroke="oklch(var(--primary))"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* Three dots inside the bubble */}
      <circle cx="76" cy="88" r="3" fill="oklch(var(--primary))" />
      <circle cx="93" cy="88" r="3" fill="oklch(var(--primary))" />
      <circle cx="110" cy="88" r="3" fill="oklch(var(--primary))" />
      {/* Coral accent dot */}
      <circle cx="146" cy="58" r="6" fill="oklch(var(--secondary-brand))" />
      {/* Subtle pattern dots */}
      <circle cx="40" cy="140" r="3" fill="oklch(var(--primary) / 0.35)" />
      <circle cx="160" cy="148" r="4" fill="oklch(var(--secondary-brand) / 0.4)" />
      <circle cx="30" cy="56" r="2.5" fill="oklch(var(--primary) / 0.30)" />
    </svg>
  );
}

/** A ticket stub with a perforated edge — for the tickets empty state. */
export function TicketEmptyArt({ size = 200, className, ...rest }: IllustrationProps): JSX.Element {
  return (
    <svg {...base(size, className)} {...rest}>
      <circle cx="100" cy="100" r="78" fill="oklch(var(--primary) / 0.08)" />
      {/* Ticket body, tilted */}
      <g transform="translate(100 100) rotate(-8) translate(-100 -100)">
        <path
          d="M44 80a8 8 0 0 1 8-8h36v8a4 4 0 0 0 8 0v-8h60a8 8 0 0 1 8 8v8a8 8 0 0 0 0 16v8a8 8 0 0 0 0 16v8a8 8 0 0 1-8 8h-60v-8a4 4 0 0 0-8 0v8H52a8 8 0 0 1-8-8v-8a8 8 0 0 0 0-16v-8a8 8 0 0 0 0-16v-8Z"
          fill="oklch(var(--primary) / 0.14)"
          stroke="oklch(var(--primary))"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {/* Lines */}
        <path
          d="M104 92h44"
          stroke="oklch(var(--primary) / 0.6)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <path
          d="M104 110h36"
          stroke="oklch(var(--primary) / 0.4)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <path
          d="M104 124h28"
          stroke="oklch(var(--primary) / 0.4)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </g>
      {/* Coral stamp */}
      <circle cx="156" cy="56" r="10" fill="oklch(var(--secondary-brand) / 0.18)" />
      <circle cx="156" cy="56" r="6" fill="oklch(var(--secondary-brand))" />
    </svg>
  );
}

/** A pair of overlapping chat bubbles — for the "no conversation selected" pane. */
export function ConversationPlaceholderArt({
  size = 220,
  className,
  ...rest
}: IllustrationProps): JSX.Element {
  return (
    <svg {...base(size, className)} {...rest}>
      <circle cx="100" cy="100" r="86" fill="oklch(var(--primary) / 0.06)" />
      {/* Far bubble (coral) */}
      <path
        d="M40 76a14 14 0 0 1 14-14h52a14 14 0 0 1 14 14v22a14 14 0 0 1-14 14h-32l-16 12v-12H54a14 14 0 0 1-14-14V76Z"
        fill="oklch(var(--secondary-brand) / 0.16)"
        stroke="oklch(var(--secondary-brand))"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* Near bubble (primary) */}
      <path
        d="M86 110a14 14 0 0 1 14-14h54a14 14 0 0 1 14 14v22a14 14 0 0 1-14 14h-6v12l-16-12h-32a14 14 0 0 1-14-14v-22Z"
        fill="oklch(var(--primary) / 0.18)"
        stroke="oklch(var(--primary))"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* Typing dots in near bubble */}
      <circle cx="110" cy="124" r="3" fill="oklch(var(--primary))" />
      <circle cx="124" cy="124" r="3" fill="oklch(var(--primary))" />
      <circle cx="138" cy="124" r="3" fill="oklch(var(--primary))" />
    </svg>
  );
}

/** Brand mark for login: chat bubble enclosing the "Y" wordmark. */
export function BrandMarkArt({ size = 320, className, ...rest }: IllustrationProps): JSX.Element {
  return (
    <svg {...base(size, className)} {...rest} viewBox="0 0 320 320">
      {/* Soft mesh background */}
      <defs>
        <radialGradient id="meshA" cx="20%" cy="20%" r="60%">
          <stop offset="0%" stopColor="oklch(var(--primary) / 0.45)" />
          <stop offset="100%" stopColor="oklch(var(--primary) / 0)" />
        </radialGradient>
        <radialGradient id="meshB" cx="80%" cy="80%" r="60%">
          <stop offset="0%" stopColor="oklch(var(--secondary-brand) / 0.40)" />
          <stop offset="100%" stopColor="oklch(var(--secondary-brand) / 0)" />
        </radialGradient>
      </defs>
      <rect width="320" height="320" fill="url(#meshA)" />
      <rect width="320" height="320" fill="url(#meshB)" />
      {/* Big chat bubble holding a Y */}
      <path
        d="M64 96a32 32 0 0 1 32-32h128a32 32 0 0 1 32 32v80a32 32 0 0 1-32 32h-44l-32 28v-28H96a32 32 0 0 1-32-32V96Z"
        fill="oklch(var(--card))"
        stroke="oklch(var(--primary))"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <path
        d="M120 110l40 36 40-36M160 146v36"
        stroke="oklch(var(--primary))"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Floating dot accents */}
      <circle cx="48" cy="48" r="8" fill="oklch(var(--secondary-brand))" />
      <circle cx="280" cy="260" r="10" fill="oklch(var(--primary))" />
      <circle cx="60" cy="240" r="6" fill="oklch(var(--secondary-brand) / 0.6)" />
    </svg>
  );
}
