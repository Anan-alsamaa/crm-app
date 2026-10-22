import type { JSX } from 'react';
import { Button, CloseIcon } from '@yiji/ui';

/**
 * The filter bar's Clear, in one shape on every page (owner, 2026-10-22:
 * "when a filter is applied, the Clear should get a circle so we know it can
 * be used and is not disabled").
 *
 * ALWAYS ON SCREEN, AND ITS STATE SAYS WHETHER IT CAN DO ANYTHING. It used to
 * come and go on some pages and sit as plain grey text on others, so nobody
 * could tell an available Clear from a dead one. Now `active` - "something
 * differs from how this page opens", which each caller decides from its own
 * filter state - gives an outlined pill with an x, and its absence a real
 * `disabled` button in the console's faded disabled look.
 *
 * What it does on click is the caller's, unchanged.
 */
export function ClearFiltersButton({
  active,
  onClear,
  label,
  className,
}: {
  /** True when at least one filter differs from the page's default. */
  active: boolean;
  onClear: () => void;
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={!active}
      onClick={onClear}
      iconStart={<CloseIcon size={14} />}
      data-clear-filters=""
      className={className}
    >
      {label}
    </Button>
  );
}
