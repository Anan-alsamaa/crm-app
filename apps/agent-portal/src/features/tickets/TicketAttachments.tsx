import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon, cn, Skeleton, toast } from '@yiji/ui';
import { downloadAsset } from '../../lib/directus.js';
import { useAssetBlobUrl } from '../../lib/useAssetBlobUrl.js';
import { fileLabel, isImage, isUnknownType } from '../../lib/files.js';
import { FileGlyph } from '../../components/FileGlyph.js';
import { Lightbox } from '../../components/Lightbox.js';
import type { TicketAttachment } from './api.js';

/**
 * Ticket attachment gallery — images render as live thumbnails by default
 * (no click needed to see what a file is), opening a lightbox on click;
 * non-images are typed chips that download. Files are private in Directus,
 * so both previews and downloads fetch blobs with the agent's token.
 */
export function TicketAttachments({
  attachments,
  onRemove,
}: {
  attachments: TicketAttachment[];
  onRemove?: (junctionId: string) => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ url: string; a: TicketAttachment } | null>(null);

  const download = (a: TicketAttachment) => {
    if (!a.file) return;
    void downloadAsset(a.file.id, a.file.filename ?? undefined).catch(() =>
      toast.error(t('conversation.attachFailed', { defaultValue: 'Could not open attachment.' })),
    );
  };

  const previewable = (a: TicketAttachment) =>
    !!a.file &&
    (isImage(a.file.type, a.file.filename) || isUnknownType(a.file.type, a.file.filename));
  const images = attachments.filter(previewable);
  const files = attachments.filter((a) => !previewable(a));

  return (
    <div className="space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <TicketImageThumb
              key={a.id}
              a={a}
              onOpen={(url) => setPreview({ url, a })}
              onFallbackDownload={() => download(a)}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((a) => (
            <span
              key={a.id}
              className="group inline-flex max-w-[18rem] items-center gap-2 rounded-xl bg-card/70 px-2.5 py-2 ring-1 ring-foreground/[0.06] shadow-soft"
            >
              <FileGlyph
                type={a.file?.type ?? null}
                filename={a.file?.filename ?? null}
                size="sm"
              />
              <button
                type="button"
                onClick={() => download(a)}
                className="min-w-0 flex-1 text-start focus-visible:outline-none"
              >
                <span className="block truncate text-xs font-medium text-foreground hover:underline">
                  {a.file?.filename ?? t('conversation.attachment', { defaultValue: 'Attachment' })}
                </span>
                <span className="block text-2xs text-muted-foreground">
                  {fileLabel(a.file?.filename ?? null, a.file?.type ?? null)}
                </span>
              </button>
              {onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(a.id)}
                  aria-label={t('conversation.removeAttachment', {
                    defaultValue: 'Remove attachment',
                  })}
                  className="shrink-0 text-muted-foreground transition-colors duration-fast hover:text-destructive"
                >
                  <CloseIcon size={13} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {preview && (
        <Lightbox
          url={preview.url}
          filename={preview.a.file?.filename ?? null}
          filesize={null}
          onDownload={() => download(preview.a)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function TicketImageThumb({
  a,
  onOpen,
  onFallbackDownload,
  onRemove,
}: {
  a: TicketAttachment;
  onOpen: (url: string) => void;
  onFallbackDownload: () => void;
  onRemove?: (junctionId: string) => void;
}) {
  const { t } = useTranslation();
  const { url, error } = useAssetBlobUrl(a.file?.id ?? '', !!a.file);
  const [decodeError, setDecodeError] = useState(false);

  // Undecodable/unfetchable "images" degrade to a plain download chip.
  if (!a.file || error || decodeError)
    return (
      <button
        type="button"
        onClick={onFallbackDownload}
        className="inline-flex items-center gap-2 rounded-xl bg-card/70 px-2.5 py-2 text-xs font-medium text-foreground ring-1 ring-foreground/[0.06] hover:underline"
      >
        <FileGlyph type={a.file?.type ?? null} filename={a.file?.filename ?? null} size="sm" />
        {a.file?.filename ?? t('conversation.attachment', { defaultValue: 'Attachment' })}
      </button>
    );

  return (
    <span className="group relative">
      <button
        type="button"
        disabled={!url}
        onClick={() => url && onOpen(url)}
        aria-label={t('conversation.previewImage', {
          defaultValue: 'Preview {{name}}',
          name: a.file.filename ?? 'image',
        })}
        className={cn(
          'relative block h-28 w-28 overflow-hidden rounded-xl bg-secondary',
          'ring-1 ring-foreground/[0.06] shadow-soft',
          'transition-[box-shadow,transform] duration-fast ease-out',
          'hover:shadow-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        )}
      >
        {url ? (
          <img
            src={url}
            alt={a.file.filename ?? ''}
            onError={() => setDecodeError(true)}
            className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
          />
        ) : (
          <Skeleton className="h-full w-full rounded-none" />
        )}
        {/* Filename strip so the agent knows what they're looking at. */}
        {a.file.filename && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-background/90 to-transparent px-1.5 pb-1 pt-4 text-start text-[10px] font-medium text-foreground">
            {a.file.filename}
          </span>
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(a.id)}
          aria-label={t('conversation.removeAttachment', { defaultValue: 'Remove attachment' })}
          className="absolute -end-1.5 -top-1.5 z-10 grid h-6 w-6 place-items-center rounded-full bg-background text-muted-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity duration-fast hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
        >
          <CloseIcon size={12} />
        </button>
      )}
    </span>
  );
}
