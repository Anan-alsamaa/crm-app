import type { JSX } from 'react';
import { useId } from 'react';
import { cn } from './cn.js';
import { DateField } from './DateField.js';
import { joinDateTime, splitDateTime } from './dateValue.js';

/**
 * A date-and-time field that shows the date as dd/mm/yyyy — the product's one
 * date format — paired with a plain time input.
 *
 * WHY THIS EXISTS instead of `<input type="datetime-local">`: the same reason
 * `DateField` exists. Chrome paints that control's date portion from the
 * BROWSER's locale and ignores `lang` on the document and the element alike, so
 * a US machine shows `mm/dd/yyyy` on a screen where every other date in the app
 * reads dd/mm/yyyy. There is no attribute the page controls that changes it.
 *
 * Only the DATE half needed fixing. `HH:mm` is the same everywhere the app runs
 * and carries no ambiguity worth inventing a masked input for, so the time is a
 * native `<input type="time">` — which also keeps the OS time wheel on a phone.
 * A browser that shows a 12-hour clock is still showing an unambiguous time.
 *
 * The value crossing the boundary is `yyyy-mm-ddTHH:mm`, exactly what
 * `<input type="datetime-local">` emitted, so callers keep their existing state
 * and payloads. `onChange` fires only when BOTH halves are present: half a
 * timestamp is not a timestamp, and pushing `2026-08-21T` upstream would store
 * or query against nonsense.
 */

export interface DateTimeFieldProps {
  /** `yyyy-mm-ddTHH:mm`, or `''` for empty. */
  value: string | null | undefined;
  /** Fires with `yyyy-mm-ddTHH:mm`, or `''` when cleared. Never partial. */
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  className?: string;
  /**
   * Upper/lower bound as `yyyy-mm-ddTHH:mm`. Only the DATE part reaches the
   * picker: a time input's own min/max would apply the bound to every day, so
   * "not in the future" would wrongly forbid this afternoon on a past date.
   */
  min?: string;
  max?: string;
  disabled?: boolean;
  invalid?: boolean;
  size?: 'sm' | 'md' | 'lg';
  'aria-label'?: string;
  'aria-describedby'?: string;
}

const SIZE = {
  sm: 'h-8',
  md: 'h-9',
  lg: 'h-10',
} as const;

export function DateTimeField({
  value,
  onChange,
  id,
  name,
  className,
  min,
  max,
  disabled,
  invalid,
  size = 'lg',
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: DateTimeFieldProps): JSX.Element {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const { date, time } = splitDateTime(value);

  /**
   * Emit only a COMPLETE timestamp.
   *
   * A date with no time is not yet an answer, so it is held on screen rather
   * than pushed upstream — the same rule `DateField` applies to `21/0`. When a
   * date arrives with the time still blank the time defaults to midnight, which
   * is what somebody picking only a day means; the reverse (a time with no
   * date) has no sensible completion and stays put.
   */
  const emit = (nextDate: string, nextTime: string) => {
    const next = joinDateTime(nextDate, nextTime);
    if (next !== null) onChange(next);
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <DateField
        value={date}
        onChange={(iso) => emit(iso, time)}
        id={fieldId}
        name={name ? `${name}-date` : undefined}
        // Date-only bounds: see the note on `min`/`max` above.
        min={min ? splitDateTime(min).date : undefined}
        max={max ? splitDateTime(max).date : undefined}
        disabled={disabled}
        invalid={invalid}
        size={size}
        className="min-w-0 flex-1"
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
      />
      <input
        type="time"
        value={time}
        name={name ? `${name}-time` : undefined}
        disabled={disabled}
        onChange={(e) => emit(date, e.target.value)}
        aria-label={ariaLabel ? `${ariaLabel} — time` : 'Time'}
        className={cn(
          'w-[7.5rem] shrink-0 rounded-2xl bg-input px-3 text-foreground',
          'ring-1 ring-inset transition-[box-shadow,background-color] duration-fast ease-out',
          'focus:outline-none focus-visible:ring-2',
          'disabled:cursor-not-allowed disabled:opacity-60',
          invalid
            ? 'ring-destructive/60 focus-visible:ring-destructive/50'
            : 'ring-foreground/[0.08] hover:ring-foreground/[0.14] focus-visible:ring-primary/40',
          SIZE[size],
        )}
      />
    </div>
  );
}
