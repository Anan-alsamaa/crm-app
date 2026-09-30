import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';

/**
 * A small emoji picker for the reply composer (owner, 2026-09-30).
 *
 * HAND-ROLLED rather than a dependency. The full emoji set is ~1,900 characters
 * and every off-the-shelf picker ships a searchable index plus sprite sheets —
 * hundreds of kilobytes on a page agents keep open all day, for a control used
 * to add a smile to a reply. This is the set a support agent actually reaches
 * for, in the order they reach for it.
 *
 * Portalled, like `SelectMenu` and `MultiSelectMenu`, so it is never clipped by
 * the composer's own overflow.
 */

/*
 * WHAT IS HERE, AND WHY THESE.
 *
 * Warm and neutral first, because this is customer service: greeting, thanks,
 * reassurance, apology. Nothing sarcastic, nothing that could read as mocking a
 * customer who is already unhappy — the owner's standing rule is that the
 * customer is the king, and an agent should not be able to pick something barbed
 * by accident.
 */
const GROUPS: ReadonlyArray<{ key: string; label: string; emoji: readonly string[] }> = [
  {
    key: 'warm',
    label: 'Warm',
    emoji: ['🙏', '😊', '🌷', '❤️', '🤝', '👍', '✅', '⭐', '🎉', '☺️', '💐', '🌟'],
  },
  {
    key: 'faces',
    label: 'Faces',
    emoji: ['🙂', '😀', '😄', '😁', '😉', '😍', '🤗', '😎', '🥰', '😇', '🙌', '👏'],
  },
  {
    key: 'care',
    label: 'Care',
    emoji: ['😔', '😢', '🥺', '😞', '🙇', '💔', '😟', '😥', '🤲', '💙', '💚', '💜'],
  },
  {
    key: 'order',
    label: 'Order',
    emoji: ['🍽️', '🍔', '🍕', '🥤', '☕', '🛍️', '🚗', '🛵', '📦', '⏰', '📍', '🧾'],
  },
  {
    key: 'signs',
    label: 'Signs',
    emoji: ['📞', '💬', '✉️', '🔔', '❗', '❓', '➡️', '⬅️', '🔁', '💯', '🆗', '🙋'],
  },
];

export interface EmojiPickerProps {
  /** Called with the chosen emoji — the caller inserts it at the caret. */
  onPick: (emoji: string) => void;
  /** Accessible name for the trigger. */
  label: string;
  disabled?: boolean;
  className?: string;
}

export function EmojiPicker({ onPick, label, disabled, className }: EmojiPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        // Back to the trigger, or focus is stranded on a closed panel.
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

  const rect = () => triggerRef.current?.getBoundingClientRect();

  return (
    <div ref={wrap} className={cn('relative inline-flex', className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          'text-muted-foreground transition-colors duration-fast ease-out',
          'hover:bg-secondary hover:text-foreground active:enabled:scale-95',
          'disabled:cursor-not-allowed disabled:opacity-40',
          open && 'bg-secondary text-foreground',
        )}
      >
        {/* A face outline rather than a literal emoji: an emoji glyph here would
            render in the OS font and sit oddly beside the paperclip's stroke
            icon. */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="h-5 w-5"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" strokeLinecap="round" />
          <circle cx="9" cy="10" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="15" cy="10" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="dialog"
            aria-label={label}
            style={{
              position: 'fixed',
              /* ABOVE the trigger. The composer sits at the foot of the screen,
                 so a panel opening downwards would fall off it. */
              bottom: Math.max(8, window.innerHeight - (rect()?.top ?? 0) + 6),
              left: Math.max(8, rect()?.left ?? 0),
            }}
            className="z-50 max-h-80 w-[19rem] overflow-y-auto rounded-2xl bg-card p-3 shadow-float ring-1 ring-foreground/10"
          >
            {GROUPS.map((g) => (
              <div key={g.key} className="mb-2 last:mb-0">
                <div className="mb-1 px-0.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {g.label}
                </div>
                <div className="grid grid-cols-6 gap-0.5">
                  {g.emoji.map((e) => (
                    <button
                      key={e}
                      type="button"
                      /* The panel STAYS OPEN: adding two or three in a row is
                         the normal case, and closing after each one would make
                         that three round trips. */
                      onClick={() => onPick(e)}
                      aria-label={e}
                      className="grid h-9 w-9 place-items-center rounded-lg text-xl leading-none transition-colors duration-fast hover:bg-secondary"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
