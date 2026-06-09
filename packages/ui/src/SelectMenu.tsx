import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';

export interface SelectMenuOption {
  value: string;
  label: ReactNode;
  /** Optional leading dot/icon colour (e.g. a status or tag colour). */
  dot?: string;
  disabled?: boolean;
}

export interface SelectMenuProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectMenuOption[];
  /** Shown when no option matches `value`. */
  placeholder?: ReactNode;
  size?: 'sm' | 'md';
  invalid?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  'aria-label'?: string;
  className?: string;
  /** Trigger style: a bordered field (forms) or a borderless ghost pill (toolbars). */
  variant?: 'field' | 'ghost';
  /** Small muted lead label shown before the value in the trigger (e.g. "Status"). */
  leading?: ReactNode;
}

/**
 * Accessible custom dropdown — replaces the native <select> menu (which the OS
 * styles inconsistently) with a styled, animated listbox. Rendered in a portal
 * with fixed positioning so it never clips inside scrolling/overflow containers,
 * and flips above the trigger when there isn't room below.
 *
 * Keyboard: Enter/Space/↓ opens; ↑/↓ move; Home/End jump; Enter selects;
 * Esc closes; type-ahead jumps to the first matching label. Closes on
 * outside-click. ARIA combobox + listbox semantics throughout.
 */
export function SelectMenu({
  value,
  onChange,
  options,
  placeholder,
  size = 'md',
  invalid,
  disabled,
  fullWidth,
  className,
  variant = 'field',
  leading,
  ...aria
}: SelectMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [coords, setCoords] = useState<{ left: number; top: number; width: number; up: boolean }>({
    left: 0,
    top: 0,
    width: 0,
    up: false,
  });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const typeahead = useRef<{ buf: string; at: number }>({ buf: '', at: 0 });
  const listId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 280 && r.top > below;
    setCoords({ left: r.left, top: up ? r.top : r.bottom, width: r.width, up });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place, selectedIndex]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return;
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  // Outside-click + Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(active);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now();
      typeahead.current.buf =
        now - typeahead.current.at > 600 ? e.key : typeahead.current.buf + e.key;
      typeahead.current.at = now;
      const q = typeahead.current.buf.toLowerCase();
      const i = options.findIndex((o) => String(o.label).toLowerCase().startsWith(q));
      if (i >= 0) setActive(i);
    }
  };

  const triggerCls =
    variant === 'ghost'
      ? cn(
          'inline-flex items-center gap-1.5 rounded-full text-xs text-muted-foreground transition-colors duration-fast ease-out',
          'hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          size === 'sm' ? 'h-7 px-2.5' : 'h-8 px-3',
        )
      : cn(
          'inline-flex items-center justify-between gap-2 rounded-xl border bg-card/60 text-start text-foreground',
          'transition-[box-shadow,border-color,background-color] duration-fast ease-out',
          'hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          size === 'sm' ? 'h-8 ps-3 pe-2 text-xs' : 'h-10 ps-3.5 pe-2.5 text-sm',
          invalid ? 'border-destructive' : 'border-border',
        );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={aria['aria-label']}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKey}
        className={cn(triggerCls, fullWidth && 'w-full', disabled && 'opacity-50', className)}
      >
        {leading && <span className="shrink-0 text-muted-foreground">{leading}</span>}
        <span
          className={cn(
            'truncate',
            variant === 'ghost' ? 'font-medium text-foreground' : '',
            !selected && 'text-muted-foreground',
          )}
        >
          {selected ? (
            <span className="inline-flex items-center gap-1.5">
              {selected.dot && (
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: selected.dot }}
                />
              )}
              {selected.label}
            </span>
          ) : (
            (placeholder ?? '—')
          )}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 10 6"
          fill="none"
          className={cn(
            'h-2 w-2 shrink-0 text-muted-foreground transition-transform duration-fast ease-out',
            open && 'rotate-180',
          )}
        >
          <path
            d="M1 1l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            className={cn(
              'fixed z-[60] max-h-72 overflow-auto rounded-xl bg-popover p-1 text-sm shadow-xl shadow-foreground/15 ring-1 ring-foreground/[0.08] animate-scale-in',
              coords.up ? 'origin-bottom' : 'origin-top',
            )}
            style={{
              left: coords.left,
              width: Math.max(coords.width, 160),
              ...(coords.up
                ? { bottom: window.innerHeight - coords.top + 6 }
                : { top: coords.top + 6 }),
            }}
          >
            {options.map((o, i) => {
              const isSel = o.value === value;
              return (
                <li key={o.value} role="option" aria-selected={isSel}>
                  <button
                    type="button"
                    disabled={o.disabled}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(i)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start transition-colors duration-fast',
                      i === active ? 'bg-secondary text-foreground' : 'text-foreground/90',
                      o.disabled && 'opacity-40',
                    )}
                  >
                    {o.dot !== undefined && (
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: o.dot || 'transparent' }}
                      />
                    )}
                    <span className="flex-1 truncate">{o.label}</span>
                    {isSel && (
                      <svg
                        aria-hidden
                        viewBox="0 0 16 16"
                        fill="none"
                        className="h-3.5 w-3.5 shrink-0 text-primary"
                      >
                        <path
                          d="M13 4.5 6.5 11 3 7.5"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </>
  );
}
