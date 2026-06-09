import type { JSX, SVGAttributes } from 'react';
import { cn } from './cn.js';

/*
 * Hand-rolled icon set, lucide-style stroke. Kept minimal so we never pull
 * in a 200kb icon library for the 12 glyphs the CRM actually needs.
 * All icons are 24x24 viewBox, 1.75 stroke, rounded join/cap.
 */

export type IconProps = SVGAttributes<SVGElement> & { size?: number };

function svgProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    className: cn('shrink-0', className),
  };
}

export function InboxIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
    </svg>
  );
}

export function TicketIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" />
      <path d="M13 17v2" />
      <path d="M13 11v2" />
    </svg>
  );
}

export function BellIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function SettingsIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function UsersIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function TeamIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M18 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="10" cy="7" r="4" />
      <path d="M22 11h-6" />
      <path d="M19 8v6" />
    </svg>
  );
}

export function ClockIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

export function SearchIcon({ size = 16, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function SignOutIcon({ size = 16, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

export function MenuIcon({ size = 20, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M3 6h18" />
      <path d="M3 12h18" />
      <path d="M3 18h18" />
    </svg>
  );
}

export function CloseIcon({ size = 20, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function ArrowLeftIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

export function InfoIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

export function SoundOnIcon({ size = 16, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

export function SoundOffIcon({ size = 16, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="m23 9-6 6" />
      <path d="m17 9 6 6" />
    </svg>
  );
}
