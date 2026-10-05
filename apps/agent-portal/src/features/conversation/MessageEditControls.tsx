import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@yiji/ui';

/*
 * Edit / delete for an agent's OWN reply (owner, 2026-10-05 (EMA-33)).
 *
 * Kept out of ConversationView so the behaviour — Enter saves, Esc cancels,
 * an empty edit cannot be saved — can be tested by rendering, not by reading
 * source. Who may see these buttons is decided by the caller
 * (`canOfferMessageActions`); the gateway enforces it either way.
 */

/*
 * ALWAYS VISIBLE, WITH WORDS (owner, 2026-10-06: "I don't see EMA-33 on
 * staging"). They were icon-only and `opacity-0` until the bubble was hovered —
 * a faint pencil beside Copy that nobody found, and invisible on a touch
 * screen. Like WhatsApp's message menu, the options now sit plainly under every
 * reply that can still be changed, and disappear when the 15 minutes run out.
 */
const ICON_BUTTON =
  'inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-2xs font-medium text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

/** Hover actions beside an own reply: Edit (only when it has text) and Delete. */
export function OwnMessageActions({
  canEdit,
  onEdit,
  onDelete,
}: {
  /** False for an attachment-only reply: there is no wording to correct. */
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {canEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={t('conversation.editMessage', { defaultValue: 'Edit message' })}
          className={ICON_BUTTON}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
            aria-hidden
          >
            <path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z" />
          </svg>
          <span aria-hidden>{t('conversation.editShort', { defaultValue: 'Edit' })}</span>
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        aria-label={t('conversation.deleteMessage', { defaultValue: 'Delete message' })}
        className={cn(ICON_BUTTON, 'hover:text-destructive')}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden
        >
          <path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6" />
        </svg>
        <span aria-hidden>{t('conversation.deleteShort', { defaultValue: 'Delete' })}</span>
      </button>
    </>
  );
}

/** Inline editor that replaces the bubble while an own reply is being corrected. */
export function InlineMessageEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const trimmed = text.trim();
  // Saving the same words would stamp "edited" on a message nobody changed.
  const canSave = trimmed.length > 0 && trimmed !== initial.trim();
  const save = () => {
    if (canSave) onSave(trimmed);
  };
  return (
    <div className="flex w-full min-w-[16rem] flex-col gap-1.5">
      <textarea
        ref={ref}
        value={text}
        rows={Math.min(6, Math.max(2, text.split('\n').length))}
        aria-label={t('conversation.editMessage', { defaultValue: 'Edit message' })}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
        className="w-full resize-none rounded-xl border border-input bg-background px-3 py-2 text-[15px] leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
      />
      <div className="flex items-center justify-end gap-1.5 text-xs">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground disabled:opacity-50"
        >
          {t('actions.save', { ns: 'common', defaultValue: 'Save' })}
        </button>
      </div>
    </div>
  );
}
