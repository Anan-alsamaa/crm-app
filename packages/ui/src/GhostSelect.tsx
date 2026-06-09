import type { JSX, ReactNode } from 'react';
import { SelectMenu } from './SelectMenu.js';

export interface GhostSelectOption {
  value: string;
  label: string;
}

export interface GhostSelectProps {
  /** Small lead label (e.g. "Status"). Optional. */
  label?: ReactNode;
  /** Current value. */
  value: string;
  /** Deprecated: the resolved display label is now derived from `options`. */
  display?: ReactNode;
  /** Plain string callback so consumers don't think about events. */
  onChange: (value: string) => void;
  /** Options list. */
  options: GhostSelectOption[];
  /** Size — `sm` for filter rows, `md` for default toolbar use. */
  size?: 'sm' | 'md';
  className?: string;
  'aria-label'?: string;
}

/**
 * Borderless ghost-pill dropdown for toolbars/filter rows. Now backed by the
 * accessible {@link SelectMenu} (styled popover listbox) instead of the native
 * <select> menu, so the open menu matches the product surface on every OS.
 */
export function GhostSelect({
  label,
  value,
  onChange,
  options,
  size = 'md',
  className,
  ...aria
}: GhostSelectProps): JSX.Element {
  return (
    <SelectMenu
      variant="ghost"
      leading={label}
      value={value}
      onChange={onChange}
      options={options}
      size={size}
      className={className}
      aria-label={aria['aria-label']}
    />
  );
}
