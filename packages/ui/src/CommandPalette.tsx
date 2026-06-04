import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from './cn.js';

/*
 * Command palette. Cmd+K / Ctrl+K triggers it from anywhere; the consuming
 * app builds a list of CommandGroups (pages, dynamic content, quick actions)
 * and the palette handles filter + keyboard navigation + selection.
 *
 * Inspired by Raycast / Linear / Cron. Keyboard-first:
 *   - Cmd+K / Ctrl+K to open
 *   - Esc / click backdrop to close
 *   - ↑ / ↓ to move selection
 *   - Enter to run
 *
 * The palette is presentation only — selection routing belongs to the caller.
 */

export interface CommandItem {
  id: string;
  /** Visible label. Matched against the filter input. */
  label: string;
  /** Optional sub-line shown below the label (truncated). */
  meta?: ReactNode;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Optional trailing keyboard shortcut hint (rendered as <kbd>). */
  shortcut?: string;
  /** Searchable keywords beyond the label (e.g. email aliases). */
  keywords?: string[];
  onSelect: () => void;
}

export interface CommandGroup {
  id: string;
  heading: string;
  items: CommandItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  groups: CommandGroup[];
  placeholder?: string;
  emptyHint?: ReactNode;
}

/** Tiny fuzzy match — case-insensitive substring across label + keywords. */
function matches(item: CommandItem, q: string): boolean {
  if (!q) return true;
  const lc = q.toLowerCase();
  if (item.label.toLowerCase().includes(lc)) return true;
  for (const k of item.keywords ?? []) {
    if (k.toLowerCase().includes(lc)) return true;
  }
  return false;
}

export function CommandPalette({
  open,
  onClose,
  groups,
  placeholder = 'Type a command, search a conversation, or jump to a page…',
  emptyHint = 'Nothing matches that.',
}: CommandPaletteProps): JSX.Element | null {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Filter + flatten so cursor is a single index across all groups.
  const visibleGroups = useMemo(() => {
    return groups
      .map((g) => ({ ...g, items: g.items.filter((it) => matches(it, q)) }))
      .filter((g) => g.items.length > 0);
  }, [groups, q]);

  const flat = useMemo(() => visibleGroups.flatMap((g) => g.items), [visibleGroups]);

  useEffect(() => {
    setCursor(0);
  }, [q, open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
    else setQ('');
  }, [open]);

  // Scroll the focused item into view when the cursor moves.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  // Close on Esc when the input isn't focused either.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (flat.length === 0 ? 0 : (c + 1) % flat.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (flat.length === 0 ? 0 : (c - 1 + flat.length) % flat.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = flat[cursor];
      if (it) {
        it.onSelect();
        onClose();
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh] animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-foreground/20 backdrop-blur-md"
        onClick={onClose}
      />
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl bg-popover/95 backdrop-blur-md text-popover-foreground shadow-2xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in origin-top">
        {/* Search input */}
        <div className="flex items-center gap-3 px-5">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder={placeholder}
            className="h-12 flex-1 border-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-0 text-start"
          />
          <kbd className="hidden shrink-0 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-2xs text-muted-foreground sm:inline">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
          {flat.length === 0 ? (
            <div className="px-3 py-12 text-center text-sm text-muted-foreground">{emptyHint}</div>
          ) : (
            visibleGroups.map((g) => {
              const startIdx = flat.findIndex((it) => g.items[0] && it.id === g.items[0].id);
              return (
                <div key={g.id} className="mb-1">
                  <h3 className="px-2 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {g.heading}
                  </h3>
                  <ul>
                    {g.items.map((it, i) => {
                      const idx = startIdx + i;
                      const active = idx === cursor;
                      return (
                        <li key={it.id}>
                          <button
                            type="button"
                            data-idx={idx}
                            onMouseEnter={() => setCursor(idx)}
                            onClick={() => {
                              it.onSelect();
                              onClose();
                            }}
                            className={cn(
                              'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-start text-sm transition-colors duration-fast ease-out',
                              active ? 'bg-secondary text-foreground' : 'text-foreground',
                            )}
                          >
                            {it.icon && (
                              <span
                                className={cn(
                                  'grid h-7 w-7 shrink-0 place-items-center rounded-md',
                                  active
                                    ? 'bg-primary-subtle text-primary'
                                    : 'bg-secondary/70 text-muted-foreground',
                                )}
                              >
                                {it.icon}
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{it.label}</span>
                              {it.meta && (
                                <span className="block truncate text-xs text-muted-foreground">
                                  {it.meta}
                                </span>
                              )}
                            </span>
                            {it.shortcut && (
                              <kbd className="hidden shrink-0 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-2xs text-muted-foreground sm:inline">
                                {it.shortcut}
                              </kbd>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 bg-secondary/30 px-5 py-2.5 text-2xs text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono">↑</kbd>
              <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono">↓</kbd>
              <span>navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono">↵</kbd>
              <span>select</span>
            </span>
          </span>
          <span>YIJI CRM</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook that listens for Cmd/Ctrl+K anywhere in the document and toggles the
 * provided open/close handlers. Returns nothing; caller manages its own state.
 */
export function useCommandPaletteShortcut(onOpen: () => void): void {
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpen]);
}
