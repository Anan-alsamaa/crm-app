import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@yiji/ui';

/*
 * Edit / delete for an agent's OWN reply (owner, 2026-10-05 (EMA-33)).
 *
 * Kept out of ConversationView so the behaviour — Enter saves, Esc cancels,
 * an empty edit cannot be saved — can be tested by rendering, not by reading
 * source. Who may see these actions is decided by the caller
 * (`canOfferMessageActions`); the gateway enforces it either way.
 */

/*
 * SELECT A MESSAGE, THEN ICONS — LIKE WHATSAPP (owner, 2026-10-07).
 *
 * History: first faint icons beside Copy that nobody found (10-05), then the
 * words "Edit" / "Delete" on hover in place of Copy (10-06). The owner's call
 * now: "instead of 2 buttons let there be icons — like WhatsApp, they can
 * select a message and delete or modify it."
 *
 * So a click on the bubble SELECTS it and pins a compact icon bar beside it:
 * copy for any message, plus pencil and trash on the agent's own reply while
 * it is still changeable. Hover still previews the bar on desktop, keyboard
 * focus reveals it, and every icon is named by aria-label AND title, so a
 * screen reader and a hovering mouse both say what it does.
 */
const ICON_BUTTON =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color] duration-fast ease-out hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

function Glyph({ d }: { d: string }) {
  return (
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
      <path d={d} />
    </svg>
  );
}

const COPY_PATH =
  'M7 5.5h5A1.5 1.5 0 0 1 13.5 7v5a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 12V7A1.5 1.5 0 0 1 7 5.5zM10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2';
const PENCIL_PATH = 'M11 2.5l2.5 2.5L6 12.5H3.5V10z';
const TRASH_PATH =
  'M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6';

/**
 * The icon bar beside a message. Each action is offered only when its handler
 * is given: copy for any message with words, edit/delete only where the caller
 * (`canOfferMessageActions` + `edit_own_messages`) allows. The gateway
 * enforces the rules either way.
 */
export function MessageActions({
  selected,
  onCopy,
  onEdit,
  onDelete,
}: {
  /** The message is selected: the bar stays visible, not only on hover. */
  selected: boolean;
  onCopy?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  if (!onCopy && !onEdit && !onDelete) return null;
  const copyLabel = t('conversation.copyMessage', { defaultValue: 'Copy message' });
  const editLabel = t('conversation.editMessage', { defaultValue: 'Edit message' });
  const deleteLabel = t('conversation.deleteMessage', { defaultValue: 'Delete message' });
  return (
    <div
      role="toolbar"
      aria-label={t('conversation.messageActions', { defaultValue: 'Message actions' })}
      data-selected={selected ? 'true' : undefined}
      // A click on an icon must not toggle the bubble's selection.
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'flex shrink-0 items-center gap-0.5 rounded-full bg-card/90 p-0.5 shadow-soft ring-1 ring-foreground/[0.06] transition-opacity duration-fast ease-out',
        selected ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover/msg:opacity-100',
      )}
    >
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          aria-label={copyLabel}
          title={copyLabel}
          className={ICON_BUTTON}
        >
          <Glyph d={COPY_PATH} />
        </button>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={editLabel}
          title={editLabel}
          className={ICON_BUTTON}
        >
          <Glyph d={PENCIL_PATH} />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={deleteLabel}
          title={deleteLabel}
          className={cn(ICON_BUTTON, 'hover:text-destructive')}
        >
          <Glyph d={TRASH_PATH} />
        </button>
      )}
    </div>
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
