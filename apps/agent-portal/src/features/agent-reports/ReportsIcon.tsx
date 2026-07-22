import type { JSX } from 'react';
import type { IconProps } from '@yiji/ui';

/**
 * Bar-chart glyph for the Reports nav item. Kept in its own tiny module (no
 * heavy imports) so `App.tsx` can pull just the icon eagerly while the report
 * page itself stays code-split. Matches the stroke conventions of the shared
 * `@yiji/ui` icons so it sits flush with them in the rail.
 */
export function ReportsIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      {...rest}
    >
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="5" />
      <rect x="12.5" y="8" width="3" height="9" />
      <rect x="18" y="5" width="3" height="12" />
    </svg>
  );
}
