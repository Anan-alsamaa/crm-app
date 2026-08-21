import type { JSX } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from './cn.js';
import { displayToIso, isoToDisplay, maskDateInput } from './dateValue.js';

/**
 * A date field that reads and writes dd/mm/yyyy — the product's one date
 * format — while still handing the browser's real calendar to anyone who wants
 * to pick rather than type.
 *
 * WHY THIS EXISTS instead of `<input type="date">`: Chrome renders that
 * control's text from the BROWSER's locale and ignores `lang` on the document
 * and on the element alike. That was verified rather than assumed — an en-GB
 * browser with `lang="en-GB"` set in both places still painted `mm/dd/yyyy`.
 * There is no attribute, no CSS, and no locale setting the page controls that
 * changes it, so the visible text has to be ours.
 *
 * The calendar is NOT given up to get that. A visually-hidden native date input
 * sits behind the trigger and `showPicker()` opens the real thing — the same
 * grid, and on a phone the same OS date wheel. A calendar grid shows a month of
 * numbered days, so it carries none of the dd/mm ambiguity the text form does;
 * only the typed representation needed fixing.
 *
 * The value crossing the boundary is always ISO `yyyy-mm-dd`, exactly what
 * `<input type="date">` emitted, so callers keep their existing state, query
 * strings and payloads. `onChange` fires with the ISO string, or `''` when the
 * field is cleared — and NOT while a half-typed date is on screen, since `21/0`
 * is not a date and pushing it upstream would refetch against nonsense.
 */

export interface DateFieldProps {
  /** ISO `yyyy-mm-dd`, or `''` for empty. */
  value: string | null | undefined;
  /** Fires with ISO `yyyy-mm-dd`, or `''` when cleared. Never partial input. */
  onChange: (iso: string) => void;
  id?: string;
  name?: string;
  className?: string;
  /** ISO bounds, passed through to the native picker. */
  min?: string;
  max?: string;
  disabled?: boolean;
  invalid?: boolean;
  /**
   * Field height. An explicit prop rather than a height class through
   * `className`, because `cn` is a plain joiner and not tailwind-merge — a
   * caller's `h-9` would sit alongside the component's own height and the
   * winner would be decided by Tailwind's stylesheet order, not by the caller.
   * `className` carries width and layout only.
   */
  size?: 'sm' | 'md' | 'lg';
  'aria-label'?: string;
  'aria-describedby'?: string;
}

const fieldBase =
  'block w-full rounded-2xl bg-input text-foreground ' +
  'placeholder:text-muted-foreground/60 ' +
  'ring-1 ring-inset ' +
  'transition-[box-shadow,background-color] duration-fast ease-out ' +
  'focus:outline-none focus-visible:ring-2 ' +
  'disabled:opacity-60 disabled:cursor-not-allowed';

/** The wrapper owns the height; the input fills it. See `size` on the props. */
const SIZE = {
  sm: 'h-8',
  md: 'h-9',
  lg: 'h-10',
} as const;

const fieldRing = (invalid?: boolean): string =>
  invalid
    ? 'ring-destructive/60 focus-visible:ring-destructive/50'
    : 'ring-foreground/[0.08] hover:ring-foreground/[0.14] focus-visible:ring-primary/40';

function CalendarIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="2" y="3.5" width="12" height="11" rx="2.5" />
      <path d="M2 6.75h12M5.5 1.75v3M10.5 1.75v3" />
    </svg>
  );
}

export function DateField({
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
}: DateFieldProps): JSX.Element {
  const nativeRef = useRef<HTMLInputElement>(null);
  const autoId = useId();
  const inputId = id ?? autoId;

  // The typed text is local state so a half-finished date can sit on screen
  // without being pushed upstream. It re-syncs whenever the committed value
  // changes to something the text does not already represent — which covers a
  // parent resetting the filter, and skips clobbering the caret mid-typing.
  const [text, setText] = useState(() => isoToDisplay(value));
  useEffect(() => {
    const iso = value ?? '';
    if (displayToIso(text) !== (iso || null)) setText(isoToDisplay(iso));
    // `text` is deliberately not a dependency: this effect exists to pull the
    // prop DOWN into the text, and listing it would make every keystroke fight
    // the parent for control of the field.
  }, [value]);

  const commit = (next: string): void => {
    setText(next);
    if (next === '') {
      onChange('');
      return;
    }
    const iso = displayToIso(next);
    if (iso) onChange(iso);
  };

  const openPicker = (): void => {
    const el = nativeRef.current;
    if (!el || disabled) return;
    // showPicker() is the supported way in (and since) Chrome 99; .click() is
    // the fallback for anything that predates it, and throws nowhere.
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        /* not user-activated, or unsupported for this input — fall through */
      }
    }
    el.click();
  };

  return (
    <div className={cn('relative', SIZE[size], className)}>
      <input
        id={inputId}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        // Latin order is part of the format. Without this the slashes and
        // digit groups reorder inside an RTL page and 21/08/2026 stops being
        // the string the user typed.
        dir="ltr"
        placeholder="dd/mm/yyyy"
        maxLength={10}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        value={text}
        onChange={(e) => commit(maskDateInput(e.target.value))}
        onBlur={() => {
          // An incomplete date is not a date. Rather than leave "21/0" sitting
          // in the field looking committed, fall back to whatever value the
          // parent still holds — or empty, if the user was clearing it.
          if (text !== '' && !displayToIso(text)) {
            setText(isoToDisplay(value));
          }
        }}
        className={cn(
          fieldBase,
          'h-full ps-3.5 pe-9 text-start',
          size === 'sm' ? 'text-xs' : 'text-sm',
          fieldRing(invalid),
        )}
      />

      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onClick={openPicker}
        // The text input is the labelled, keyboard-reachable control; this is a
        // pointer shortcut to the same value, so it stays out of the tab order
        // and is hidden from assistive tech rather than announced as a second
        // way to do the thing that was just announced.
        aria-hidden
        className={cn(
          'absolute inset-y-0 end-0 grid w-9 place-items-center rounded-e-2xl',
          'text-muted-foreground transition-colors duration-fast ease-out',
          'hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <CalendarIcon />
      </button>

      {/*
        The real picker. Kept in the layout (not `display:none`) because a
        hidden input cannot be opened, but given no size and no pointer events
        so it never catches a click meant for the field.
      */}
      <input
        ref={nativeRef}
        type="date"
        tabIndex={-1}
        aria-hidden
        disabled={disabled}
        min={min}
        max={max}
        value={value ?? ''}
        onChange={(e) => commit(isoToDisplay(e.target.value))}
        className="pointer-events-none absolute bottom-0 end-8 h-0 w-0 opacity-0"
      />
    </div>
  );
}
