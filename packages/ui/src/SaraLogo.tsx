import type { JSX } from 'react';
import { cn } from './cn.js';

/**
 * The SARA mark, in the family of SARA Connect and SARA POS.
 *
 * Six slanted bars: one slit into three segments, one long descender that runs
 * past the baseline, one full-height, and three short. Traced from the official
 * SARA Connect artwork rather than eyeballed — bar width 140, pitch 211, slant
 * dx/dy −0.334 (≈18.5°), on a 1289 × 842 field. Redrawn as vector because the
 * old brand shipped as a PNG, which meant a soft mark on every retina screen
 * and no way to recolour it per theme.
 *
 * Colour is `currentColor` throughout and is NOT set here. That is the whole
 * point: the logo is whatever the surface it sits on says it is — brand blue on
 * a card, white on the ink masthead — so it matches the product by construction
 * instead of by somebody remembering to update a second hex. Callers set it,
 * because only the caller knows what it is standing on.
 */

/** One parallelogram, in the traced coordinate space. */
const BARS: ReadonlyArray<string> = [
  // Bar 1 — slit into three by two thin gaps.
  '187.4,0 327.4,0 304.7,68 164.7,68',
  '159.4,84 299.4,84 281,139 141,139',
  '136,154 276,154 140,561 0,561',
  // Bar 2 — the descender that carries below the wordmark.
  '304.6,281 444.6,281 257.2,842 117.2,842',
  // Bar 3 — full height.
  '609.4,0 749.4,0 562,561 422,561',
  // Bars 4–6 — the short run.
  '726.6,281 866.6,281 773,561 633,561',
  '937.6,281 1077.6,281 984,561 844,561',
  '1148.6,281 1288.6,281 1195,561 1055,561',
];

export interface SaraLogoProps {
  /** Height of the MARK in pixels. The wordmark scales with it. */
  size?: number;
  /** `mark` = bars only. `full` = bars + the "SARA CRM" wordmark. */
  variant?: 'mark' | 'full';
  /** The word after SARA. Swap it and the same mark serves another product. */
  product?: string;
  className?: string;
  /** Accessible name. Set `''` when adjacent text already names the product. */
  title?: string;
}

export function SaraLogo({
  size = 28,
  variant = 'full',
  product = 'CRM',
  className,
  title = `SARA ${product}`,
}: SaraLogoProps): JSX.Element {
  const mark = (
    <svg
      viewBox="0 0 1289 842"
      height={size}
      width={(size * 1289) / 842}
      fill="currentColor"
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      className="shrink-0 overflow-visible"
    >
      {BARS.map((points) => (
        <polygon key={points} points={points} />
      ))}
    </svg>
  );

  if (variant === 'mark') return <span className={cn(className)}>{mark}</span>;

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {mark}
      {/*
        The wordmark is TEXT, not more vector. It inherits the product's own
        type, so the logo and the interface are set in one typeface rather than
        two that drift apart — and it stays legible at the 12px the masthead
        actually renders it at, which outlined letterforms do not.

        `SARA` regular, the product word heavy: the family is the constant and
        the product is what changes, so the product is what carries the weight.
      */}
      <span
        aria-hidden
        className="text-[0.95em] font-semibold uppercase leading-none tracking-[0.14em] whitespace-nowrap"
        style={{ fontSize: Math.max(11, Math.round(size * 0.46)) }}
      >
        SARA<span className="font-extrabold tracking-[0.1em]"> {product}</span>
      </span>
    </span>
  );
}
