import type { JSX } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';

/*
 * PICK SEVERAL — a filter where one answer is not enough.
 *
 * `SelectMenu` asks "which one"; this asks "which of these", which is a
 * different question and cannot be expressed by the same control. The late
 * orders queue needs it for the ORDER STATUS filter: an agent watching for
 * trouble wants delivered, closed and cancelled at once (owner, 2026-09-29).
 *
 * EMPTY MEANS EVERYTHING, not nothing. A filter that starts by hiding every
 * row would read as a broken page, and "no preference" is the honest reading of
 * an untouched filter. The trigger says so, and "All" clears rather than
 * selecting every box — the two are the same result and the first survives a
 * new status appearing upstream.
 *
 * Portalled, like `SelectMenu`, so it is never clipped by a table's own scroll.
 */

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface MultiSelectMenuProps {
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  options: readonly MultiSelectOption[];
  /** What this filter is about — shown on the trigger when nothing is picked. */
  label: string;
  /** The "no filter" wording. Defaults to the label. */
  allLabel?: string;
  className?: string;
}

export function MultiSelectMenu({
  selected,
  onChange,
  options,
  label,
  allLabel,
  className,
}: MultiSelectMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  /*
   * WHAT THE TRIGGER SAYS. One selection is named; several are counted, because
   * three status names do not fit a filter bar and a truncated list is worse
   * than a number.
   */
  const summary =
    selected.size === 0
      ? (allLabel ?? label)
      : selected.size === 1
        ? (options.find((o) => selected.has(o.value))?.label ?? `1 ${label}`)
        : `${selected.size} selected`;

  const rect = () => triggerRef.current?.getBoundingClientRect();

  return (
    <div ref={wrap} className={cn('relative inline-block', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-8 items-center justify-between gap-2 rounded-2xl bg-input ps-3 pe-2 text-xs text-foreground',
          'ring-1 ring-inset ring-foreground/[0.08] transition-[box-shadow,background-color] duration-fast ease-out',
          'hover:ring-foreground/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          selected.size === 0 && 'text-muted-foreground',
        )}
      >
        <span className="truncate">{summary}</span>
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.75" />
        </svg>
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            id={listId}
            role="listbox"
            aria-multiselectable
            style={{
              position: 'fixed',
              top: (rect()?.bottom ?? 0) + 6,
              left: rect()?.left ?? 0,
              minWidth: rect()?.width ?? 180,
            }}
            className="z-50 max-h-72 overflow-auto rounded-xl bg-card p-1.5 shadow-float ring-1 ring-foreground/10"
          >
            {/* CLEARS rather than ticking every box: the two give the same rows,
                and this one keeps meaning "all" when a new status appears
                upstream that nobody has ticked. */}
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className={cn(
                'mb-1 block w-full rounded-lg px-2.5 py-1.5 text-start text-xs transition-colors duration-fast',
                selected.size === 0
                  ? 'bg-secondary font-semibold text-foreground'
                  : 'text-foreground/80 hover:bg-secondary/60',
              )}
            >
              {allLabel ?? label}
            </button>
            {options.length === 0 ? (
              <p className="px-2.5 py-1.5 text-2xs text-muted-foreground">—</p>
            ) : (
              options.map((o) => {
                const on = selected.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(o.value)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-xs transition-colors duration-fast',
                      on ? 'text-foreground' : 'text-foreground/80 hover:bg-secondary/60',
                    )}
                  >
                    {/* A real tick box, because "which of these" is a question
                        about a set and a highlighted row cannot show which
                        others are also on. */}
                    <span
                      aria-hidden
                      className={cn(
                        'grid h-3.5 w-3.5 shrink-0 place-items-center rounded border',
                        on
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-foreground/25',
                      )}
                    >
                      {on && (
                        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5">
                          <path
                            d="M2.5 6.5l2.5 2.5 4.5-5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </span>
                    <span className="truncate">{o.label}</span>
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
