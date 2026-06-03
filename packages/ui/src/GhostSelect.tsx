import type { JSX, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from './cn.js';

export interface GhostSelectOption {
  value: string;
  label: string;
}

export interface GhostSelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'onChange' | 'value' | 'size'
> {
  /** Small lead label (e.g. "Status"). Optional. */
  label?: ReactNode;
  /** Current value. */
  value: string;
  /** Text shown next to the chevron (the resolved display label). */
  display: ReactNode;
  /** Plain string callback so consumers don't think about events. */
  onChange: (value: string) => void;
  /** Options list. */
  options: GhostSelectOption[];
  /** Size — `sm` for filter rows, `md` for default toolbar use. */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A native <select> hidden on top of a styled label+chevron. Reads as a
 * text-button with a chevron at rest; the native menu appears on click so
 * keyboard + mobile behaviour is preserved. No border at rest.
 */
export function GhostSelect({
  label,
  value,
  display,
  onChange,
  options,
  className,
  size = 'md',
  ...rest
}: GhostSelectProps): JSX.Element {
  return (
    <label
      className={cn(
        'group relative inline-flex cursor-pointer items-center gap-1.5 rounded-full text-xs text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary/60 hover:text-foreground focus-within:bg-secondary/70 focus-within:ring-2 focus-within:ring-primary/30',
        size === 'sm' ? 'h-7 px-2.5' : 'h-8 px-3',
        className,
      )}
    >
      {label && <span>{label}</span>}
      <span className="font-medium text-foreground">{display}</span>
      <svg aria-hidden viewBox="0 0 10 6" fill="none" className="h-2 w-2 text-muted-foreground">
        <path
          d="M1 1l4 4 4-4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer appearance-none bg-transparent opacity-0 outline-none"
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
