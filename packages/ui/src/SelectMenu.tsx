import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';
import { matchesQuery, nodeText, searchStrings } from './optionSearch.js';

export interface SelectMenuOption {
  value: string;
  label: ReactNode;
  /** Optional leading dot/icon colour (e.g. a status or tag colour). */
  dot?: string;
  disabled?: boolean;
  /**
   * Text the search box matches against. Defaults to the label's own words,
   * which covers plain strings and simple elements; pass it when the label is
   * an icon or a component whose text is not in its children.
   */
  searchText?: string;
}

/**
 * The search box is shown from this many options up. A two-way choice (EN/AR,
 * Yes/No) gains nothing from a filter, while a status filter — "All" plus a
 * couple of statuses — already does: the owner named status and agent filters
 * explicitly (2026-10-26).
 */
export const SELECT_SEARCH_MIN_OPTIONS = 3;

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
  /** Tooltip, and the trigger's accessible name when there is no `aria-label`. */
  title?: string;
  className?: string;
  /** Trigger style: a bordered field (forms) or a borderless ghost pill (toolbars). */
  variant?: 'field' | 'ghost';
  /** Small muted lead label shown before the value in the trigger (e.g. "Status"). */
  leading?: ReactNode;
  /**
   * Type-to-filter. ON by default for every menu with
   * {@link SELECT_SEARCH_MIN_OPTIONS} or more options (owner, 2026-10-26: every
   * dropdown should behave like an input — type, and the matching options show
   * underneath). Pass `false` to keep a menu a plain pick-list, or `true` to
   * force the box on a shorter one.
   */
  searchable?: boolean;
  /** Overrides the built-in (EN/AR, from `<html lang>`) search placeholder. */
  searchPlaceholder?: string;
  /** Overrides the built-in (EN/AR) "no matches" wording. */
  noMatchesText?: ReactNode;
}

/**
 * Accessible custom dropdown — replaces the native <select> menu (which the OS
 * styles inconsistently) with a styled, animated listbox. Rendered in a portal
 * with fixed positioning so it never clips inside scrolling/overflow containers,
 * and flips above the trigger when there isn't room below.
 *
 * TYPE TO FILTER. The closed trigger looks exactly as before; opening it puts
 * the caret in a search box at the top of the menu, and typing on the focused
 * trigger opens it with those letters already in the box. Options filter live
 * (anywhere in the label, case/accent-insensitive, Arabic harakat + tatweel
 * ignored — see `optionSearch.ts`).
 *
 * Keyboard: Enter/Space/↓ opens; typing filters; ↑/↓ move through the matches;
 * Home/End jump; Enter selects; Esc closes, clears the search and returns focus
 * to the trigger; Tab closes and moves on. Closes on outside-click. ARIA
 * combobox + listbox semantics throughout, with `aria-activedescendant` on the
 * element that holds focus.
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
  searchable,
  searchPlaceholder,
  noMatchesText,
  title,
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const typeahead = useRef<{ buf: string; at: number }>({ buf: '', at: 0 });
  /** Letters typed on the closed trigger, handed to the search box as it opens. */
  const seed = useRef('');
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const [query, setQuery] = useState('');

  const withSearch = searchable ?? options.length >= SELECT_SEARCH_MIN_OPTIONS;
  const strings = searchStrings();

  /* The options actually rendered: every one until something is typed. */
  const shown =
    withSearch && query.trim()
      ? options.filter((o) => matchesQuery(o.searchText ?? nodeText(o.label), query))
      : options;
  // `active` can point past the end for one render after the list shrinks.
  const activeIndex = shown.length === 0 ? -1 : Math.min(active, shown.length - 1);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 280 && r.top > below;
    setCoords({ left: r.left, top: up ? r.top : r.bottom, width: r.width, up });
  }, []);

  /*
   * A fresh search each time it opens (or the letters typed on the trigger).
   * Leaving the previous query behind would reopen the menu showing a filtered
   * subset with no obvious reason. Keyed on `open` alone, so an option list that
   * finishes loading WHILE the agent types does not wipe what they typed.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const typed = seed.current;
    seed.current = '';
    setQuery(typed);
    setActive(typed ? 0 : Math.max(0, selectedIndexRef.current));
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

  // The caret goes straight into the search box.
  useEffect(() => {
    if (!open || !withSearch) return;
    const id = window.setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(id);
  }, [open, withSearch]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  // Outside-click, and an Esc that lands on neither the trigger nor the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (i: number) => {
    const o = shown[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close(true);
  };

  const move = (delta: number) =>
    setActive((a) =>
      Math.max(0, Math.min(shown.length - 1, Math.min(a, shown.length - 1) + delta)),
    );

  /** Keys that mean the same thing wherever focus sits while the menu is open. */
  const navKey = (e: React.KeyboardEvent): boolean => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Only this menu closes — not the drawer or dialog it sits in.
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(activeIndex);
    } else if (e.key === 'Tab') {
      // Back on the trigger, so the browser's own Tab moves on from THERE.
      close(true);
    } else {
      return false;
    }
    return true;
  };

  const isPrintable = (e: React.KeyboardEvent) =>
    e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

  // Keys on the trigger button (and on the menu itself when it has focus).
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      } else if (withSearch && isPrintable(e) && /\S/.test(e.key)) {
        // Typing on the closed control starts a search, like an input would.
        e.preventDefault();
        seed.current = e.key;
        setOpen(true);
      }
      return;
    }
    if (navKey(e)) return;
    if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(shown.length - 1);
    } else if (e.key === ' ' && !(withSearch && query)) {
      e.preventDefault();
      choose(activeIndex);
    } else if (withSearch && (isPrintable(e) || e.key === 'Backspace')) {
      // Focus is on the trigger (the box takes it a tick after opening):
      // feed the box rather than losing the keystroke.
      e.preventDefault();
      setQuery((q) => (e.key === 'Backspace' ? q.slice(0, -1) : q + e.key));
      setActive(0);
      searchRef.current?.focus({ preventScroll: true });
    } else if (!withSearch && e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now();
      typeahead.current.buf =
        now - typeahead.current.at > 600 ? e.key : typeahead.current.buf + e.key;
      typeahead.current.at = now;
      const q = typeahead.current.buf.toLowerCase();
      const i = shown.findIndex((o) =>
        (o.searchText ?? nodeText(o.label)).toLowerCase().startsWith(q),
      );
      if (i >= 0) setActive(i);
    }
  };

  // Keys in the search box: navigation is handled, everything else types.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    navKey(e);
  };

  const triggerCls =
    variant === 'ghost'
      ? cn(
          'inline-flex items-center gap-1.5 rounded-full text-xs text-muted-foreground transition-colors duration-fast ease-out',
          // A darker wash than the toolbar pill it sits in (owner, 2026-10-26: "a
          // lil more darker"); `secondary/60` on a `secondary/70` pill barely showed.
          'hover:bg-foreground/[0.09] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          size === 'sm' ? 'h-7 px-2.5' : 'h-8 px-3',
        )
      : cn(
          // Same inset-well language as Input: `--input` fill + inset hairline.
          'inline-flex items-center justify-between gap-2 rounded-2xl bg-input text-start text-foreground',
          'ring-1 ring-inset transition-[box-shadow,background-color] duration-fast ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          size === 'sm' ? 'h-8 ps-3 pe-2 text-xs' : 'h-10 ps-3.5 pe-2.5 text-sm',
          invalid ? 'ring-destructive/60' : 'ring-foreground/[0.08] hover:ring-foreground/[0.14]',
        );

  const activeId = open && activeIndex >= 0 ? optionId(activeIndex) : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        aria-label={aria['aria-label']}
        title={title}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (open) close(false);
          else setOpen(true);
        }}
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
          <div
            ref={panelRef}
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.target === searchRef.current)
                onSearchKey(e as React.KeyboardEvent<HTMLInputElement>);
              else onKey(e);
            }}
            /* A hook for a portal's own stylesheet; carries no styling itself. */
            data-menu-panel=""
            /* An open dialog leaves this Esc to the menu (see ConfirmDialog). */
            data-dismiss-first=""
            className={cn(
              'fixed z-[60] flex max-h-72 flex-col rounded-xl bg-popover/95 backdrop-blur p-1 text-sm shadow-xl shadow-black/30 ring-1 ring-border animate-scale-in',
              coords.up ? 'origin-bottom' : 'origin-top',
            )}
            style={{
              left: coords.left,
              width: Math.max(coords.width, withSearch ? 192 : 160),
              ...(coords.up
                ? { bottom: window.innerHeight - coords.top + 6 }
                : { top: coords.top + 6 }),
            }}
          >
            {withSearch && (
              /* A real input, so typing composes normally (Arabic, IME, paste).
                 It is the combobox the listbox below belongs to while it has
                 focus, hence the active-descendant. */
              <div className="shrink-0 p-1 pb-1.5">
                <input
                  ref={searchRef}
                  type="text"
                  role="combobox"
                  aria-expanded
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={activeId}
                  aria-label={strings.label}
                  data-menu-search=""
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.currentTarget.value);
                    // Any keystroke invalidates the highlighted row: back to
                    // the first match rather than an index into an old list.
                    setActive(0);
                  }}
                  placeholder={searchPlaceholder ?? strings.placeholder}
                  className="h-8 w-full rounded-lg bg-input px-2.5 text-xs text-foreground ring-1 ring-inset ring-foreground/[0.08] placeholder:text-muted-foreground/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                />
              </div>
            )}
            {shown.length === 0 && (
              <p role="status" className="px-2.5 py-3 text-center text-xs text-muted-foreground">
                {noMatchesText ?? strings.empty}
              </p>
            )}
            <ul ref={listRef} id={listId} role="listbox" className="min-h-0 flex-1 overflow-auto">
              {shown.map((o, i) => {
                const isSel = o.value === value;
                return (
                  <li key={o.value} id={optionId(i)} role="option" aria-selected={isSel}>
                    <button
                      type="button"
                      tabIndex={-1}
                      disabled={o.disabled}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(i)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start transition-colors duration-fast',
                        i === activeIndex ? 'bg-secondary text-foreground' : 'text-foreground/90',
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
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
