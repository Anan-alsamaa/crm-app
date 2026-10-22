import type { InputHTMLAttributes, JSX } from 'react';
import { forwardRef, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon, Input, SearchIcon, cn } from '@yiji/ui';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> & {
  value: string;
  onValueChange: (next: string) => void;
  /**
   * Runs when the x is pressed, AFTER the value is emptied. For a field whose
   * text is a draft (the report bars apply on Enter), this is where the empty
   * search is applied, so the x clears the results and not just the box.
   */
  onCleared?: () => void;
  /** Classes for the wrapper - size the field here (Input itself is w-full). */
  className?: string;
  inputClassName?: string;
};

/**
 * Every search box in the console, in one shape (owner, 2026-10-22: "also for
 * the search buttons and stuff").
 *
 * A search box has to read as one at a glance: the magnifier at the start, a
 * visible rounded outline on the card (the bare field melted into the white
 * card), a focus ring with a firmer edge, and a round x inside the field that
 * appears only when there is something to clear. The x empties THIS search and
 * keeps the caret in the box, so the next query can be typed straight away.
 */
export const SearchField = forwardRef<HTMLInputElement, Props>(function SearchField(
  { value, onValueChange, onCleared, className, inputClassName, ...rest },
  forwarded,
): JSX.Element {
  const { t } = useTranslation();
  const own = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null) => {
    own.current = el;
    if (typeof forwarded === 'function') forwarded(el);
    else if (forwarded) forwarded.current = el;
  };
  return (
    <span data-search-field="" className={cn('relative block min-w-0', className)}>
      <SearchIcon
        size={15}
        className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={setRef}
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className={cn('ps-9', value ? 'pe-10' : 'pe-3.5', inputClassName)}
        {...rest}
      />
      {value && (
        <button
          type="button"
          data-search-clear=""
          onClick={() => {
            onValueChange('');
            onCleared?.();
            own.current?.focus();
          }}
          aria-label={t('controls.clearSearch', { defaultValue: 'Clear search' })}
          title={t('controls.clearSearch', { defaultValue: 'Clear search' })}
          className="absolute end-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground"
        >
          <CloseIcon size={13} />
        </button>
      )}
    </span>
  );
});
