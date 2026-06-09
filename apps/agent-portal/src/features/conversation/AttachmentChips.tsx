import { useTranslation } from 'react-i18next';
import { cn, toast } from '@yiji/ui';
import { downloadAsset } from '../../lib/directus.js';
import type { MessageAttachment } from '../inbox/api.js';

function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
      aria-hidden
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

/**
 * Renders a message's attachments as download chips. Files are private in
 * Directus, so clicking fetches the blob with the agent's token rather than
 * relying on an unauthenticated <a href>.
 */
export function AttachmentChips({
  attachments,
  align,
}: {
  attachments?: MessageAttachment[];
  align?: 'start' | 'end';
}) {
  const { t } = useTranslation();
  if (!attachments || attachments.length === 0) return null;
  const open = (a: MessageAttachment) =>
    void downloadAsset(a.id, a.filename ?? undefined).catch(() =>
      toast.error(t('conversation.attachFailed', { defaultValue: 'Could not open attachment.' })),
    );
  return (
    <div className={cn('mt-1.5 flex flex-wrap gap-1.5', align === 'end' && 'justify-end')}>
      {attachments.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => open(a)}
          className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-lg bg-secondary/70 px-2.5 py-1.5 text-xs text-foreground ring-1 ring-foreground/[0.05] transition-colors duration-fast ease-out hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <PaperclipIcon />
          <span className="truncate">
            {a.filename ?? t('conversation.attachment', { defaultValue: 'Attachment' })}
          </span>
        </button>
      ))}
    </div>
  );
}
