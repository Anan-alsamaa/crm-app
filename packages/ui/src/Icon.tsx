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

export function ChartIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M7 15v-3" />
      <path d="M12 15V8" />
      <path d="M17 15v-5" />
    </svg>
  );
}

export function StoreIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="m2 7 2.5-4h15L22 7" />
      <path d="M2 7v2a3 3 0 0 0 5 2.24A3 3 0 0 0 12 11a3 3 0 0 0 5 .24A3 3 0 0 0 22 9V7" />
      <path d="M4 12.5V21h16v-8.5" />
      <path d="M9 21v-5h6v5" />
    </svg>
  );
}

export function UploadIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 8 5-5 5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

export function DownloadIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

export function ShieldIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function ZapIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14Z" />
    </svg>
  );
}

export function CalendarIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </svg>
  );
}

export function SparkleIcon({ size = 18, className, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size, className)} {...rest}>
      <path d="M12 3v2" />
      <path d="M12 19v2" />
      <path d="M3 12h2" />
      <path d="M19 12h2" />
      <path d="M12 7a5 5 0 0 1 5 5 5 5 0 0 1-5 5 5 5 0 0 1-5-5 5 5 0 0 1 5-5Z" />
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
