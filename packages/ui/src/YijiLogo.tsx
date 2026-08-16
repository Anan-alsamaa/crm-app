import type { JSX, SVGAttributes } from 'react';
import { cn } from './cn.js';

/*
 * Sara CRM brand mark.
 *
 * Drawn rather than loaded: an inline SVG inherits the theme, stays crisp at
 * any size, and cannot show a stale cached bitmap after a rebrand — which is
 * how the previous mark ended up sitting next to the words "Sara CRM" long
 * after the product stopped being called anything else.
 *
 * The form is a conversation turned into an S: two rounded strokes that read
 * as a reply thread at a glance and as a monogram at 20px. This is a working
 * mark, not commissioned artwork — swapping it means editing this one file.
 *
 * `variant="mark"` is the bare glyph; `variant="tile"` frames it on a soft
 * tinted square for rails and topbars.
 */

export interface YijiLogoProps extends Omit<SVGAttributes<SVGSVGElement>, 'viewBox'> {
  /** Visual size in pixels (square). Defaults to 32. */
  size?: number;
  /** `mark` = bare glyph. `tile` = glyph on a soft tinted square. */
  variant?: 'mark' | 'tile';
  /** Override the accessible name. */
  alt?: string;
}

export function YijiLogo({
  size = 32,
  variant = 'mark',
  alt = 'Sara CRM',
  className,
  ...rest
}: YijiLogoProps): JSX.Element {
  const glyph = (
    <svg
      viewBox="0 0 32 32"
      width={variant === 'tile' ? Math.round(size * 0.72) : size}
      height={variant === 'tile' ? Math.round(size * 0.72) : size}
      role="img"
      aria-label={alt}
      className={cn('select-none', variant === 'mark' && className)}
      {...rest}
    >
      <defs>
        {/* Jade into teal — the same sweep the welcome hero opens with. */}
        <linearGradient id="sara-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.72 0.15 165)" />
          <stop offset="100%" stopColor="oklch(0.62 0.13 205)" />
        </linearGradient>
      </defs>
      <g
        fill="none"
        stroke="url(#sara-mark)"
        strokeWidth="4.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Upper turn: the message that arrives. */}
        <path d="M24 9.5a7 7 0 0 0-7-3.5h-3a6 6 0 0 0 0 12" />
        {/* Lower turn: the reply that goes back, closing the S. */}
        <path d="M8 22.5a7 7 0 0 0 7 3.5h3a6 6 0 0 0 0-12" />
      </g>
    </svg>
  );

  if (variant === 'tile') {
    return (
      <span
        className={cn('grid shrink-0 place-items-center rounded-xl bg-primary-tint/70', className)}
        style={{ width: size, height: size }}
      >
        {glyph}
      </span>
    );
  }
  return glyph;
}
