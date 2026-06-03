import type { JSX, ImgHTMLAttributes } from 'react';
import { cn } from './cn.js';

/*
 * Real YIJI brand mark — references /yiji-logo.png served from each app's
 * public/ folder. The hand-drawn Arabic wordmark is the brand identity;
 * geometric placeholders ("Y" in a square) are deprecated.
 *
 * Use the `variant="mark"` for the full logo, `variant="tile"` for a
 * compact framed version (rail/topbar small spaces).
 */

export interface YijiLogoProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'> {
  /** Visual size in pixels (square). Defaults to 32. */
  size?: number;
  /** `mark` = bare logo. `tile` = logo on a soft tinted square. */
  variant?: 'mark' | 'tile';
  /** Override the alt text. */
  alt?: string;
}

export function YijiLogo({
  size = 32,
  variant = 'mark',
  alt = 'YIJI',
  className,
  ...rest
}: YijiLogoProps): JSX.Element {
  if (variant === 'tile') {
    return (
      <span
        className={cn(
          'grid place-items-center rounded-md bg-secondary/70 p-1',
          className,
        )}
        style={{ width: size, height: size }}
      >
        <img
          src="/yiji-logo.png"
          alt={alt}
          width={Math.round(size * 0.78)}
          height={Math.round(size * 0.78)}
          className="select-none"
          draggable={false}
          {...rest}
        />
      </span>
    );
  }
  return (
    <img
      src="/yiji-logo.png"
      alt={alt}
      width={size}
      height={size}
      draggable={false}
      className={cn('select-none', className)}
      {...rest}
    />
  );
}
