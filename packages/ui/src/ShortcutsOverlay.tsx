import type { JSX, ReactNode } from 'react';
import { useEffect } from 'react';
import { cn } from './cn.js';

export interface ShortcutRow {
  /** Key tokens rendered as <kbd> chips, e.g. ['g', 'i'] or ['⌘', 'K']. */
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  heading: string;
  items: ShortcutRow[];
}

export interface ShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  groups: ShortcutGroup[];
  /** Accessible label for the close button. */
  closeLabel: string;
}

/**
 * Centered modal that documents the app's keyboard shortcuts. Opened with `?`.
 * Closes on Esc / backdrop click; locks body scroll while open.
 */
export function ShortcutsOverlay({
  open,
  onClose,
  title,
  groups,
  closeLabel,
}: ShortcutsOverlayProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-foreground/30 backdrop-blur-sm motion-safe:animate-fade-in"
      />
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-2xl shadow-foreground/20 ring-1 ring-foreground/[0.06] motion-safe:animate-scale-in">
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              className="h-4 w-4"
              aria-hidden
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="max-h-[70vh] overflow-auto px-6 pb-6 space-y-5">
          {groups.map((g) => (
            <div key={g.heading}>
              <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {g.heading}
              </h3>
              <ul className="space-y-1">
                {g.items.map((row) => (
                  <li
                    key={row.label}
                    className="flex items-center justify-between gap-4 rounded-lg px-2 py-1.5"
                  >
                    <span className="text-sm text-foreground">{row.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {row.keys.map((k, i) => (
                        <kbd
                          key={i}
                          className={cn(
                            'inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-md px-1.5',
                            'bg-secondary text-2xs font-medium text-foreground ring-1 ring-foreground/[0.06]',
                          )}
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
