import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, Skeleton, toast } from '@yiji/ui';
import { downloadAsset } from '../../lib/directus.js';
import { useAssetBlobUrl } from '../../lib/useAssetBlobUrl.js';
import { fileLabel, formatBytes, isImage } from '../../lib/files.js';
import { FileGlyph } from '../../components/FileGlyph.js';
import { Lightbox } from '../../components/Lightbox.js';
import type { MessageAttachment } from '../inbox/api.js';

/**
 * Renders a message's attachments. Images become inline thumbnails that open in
 * a lightbox; everything else becomes a type-aware file chip that downloads on
 * click. Files are private in Directus, so previews/downloads fetch the blob
 * with the agent's token rather than relying on an unauthenticated <img>/<a>.
 */
export function AttachmentChips({
  attachments,
  align,
}: {
  attachments?: MessageAttachment[];
  align?: 'start' | 'end';
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ url: string; a: MessageAttachment } | null>(null);

  if (!attachments || attachments.length === 0) return null;

  const download = (a: MessageAttachment) =>
    void downloadAsset(a.id, a.filename ?? undefined).catch(() =>
      toast.error(t('conversation.attachFailed', { defaultValue: 'Could not open attachment.' })),
    );

  const images = attachments.filter((a) => isImage(a.type, a.filename));
  const files = attachments.filter((a) => !isImage(a.type, a.filename));

  return (
    <div className={cn('mt-1.5 flex flex-col gap-1.5', align === 'end' && 'items-end')}>
      {images.length > 0 && (
        <div className={cn('flex flex-wrap gap-1.5', align === 'end' && 'justify-end')}>
          {images.map((a) => (
            <ImageThumb
              key={a.id}
              a={a}
              onOpen={(url) => setPreview({ url, a })}
              onFallbackDownload={() => download(a)}
            />
          ))}
        </div>
      )}
      {files.map((a) => (
        <FileChip key={a.id} a={a} onClick={() => download(a)} />
      ))}

      {preview && (
        <Lightbox
          url={preview.url}
          filename={preview.a.filename}
          filesize={preview.a.filesize}
          onDownload={() => download(preview.a)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function ImageThumb({
  a,
  onOpen,
  onFallbackDownload,
}: {
  a: MessageAttachment;
  onOpen: (url: string) => void;
  onFallbackDownload: () => void;
}) {
  const { t } = useTranslation();
  const { url, error } = useAssetBlobUrl(a.id, true);
  // Track <img> decode failures separately: the asset can fetch fine (200) yet
  // be undecodable bytes (e.g. a file corrupted at rest), in which case the
  // image renders as a blank box. Degrade those to a file chip too.
  const [decodeError, setDecodeError] = useState(false);

  // If the thumbnail can't load (perms/network) or decode, degrade to a file chip.
  if (error || decodeError) return <FileChip a={a} onClick={onFallbackDownload} />;

  return (
    <button
      type="button"
      disabled={!url}
      onClick={() => url && onOpen(url)}
      aria-label={t('conversation.previewImage', {
        defaultValue: 'Preview {{name}}',
        name: a.filename ?? 'image',
      })}
      className={cn(
        'group relative h-32 w-32 shrink-0 overflow-hidden rounded-xl bg-secondary',
        'ring-1 ring-foreground/[0.06] shadow-sm shadow-foreground/[0.06]',
        'transition-[box-shadow,transform] duration-fast ease-out',
        'hover:shadow-md hover:shadow-foreground/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
    >
      {url ? (
        <img
          src={url}
          alt={a.filename ?? ''}
          onError={() => setDecodeError(true)}
          className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
        />
      ) : (
        <Skeleton className="h-full w-full rounded-none" />
      )}
      {/* Expand affordance on hover */}
      <span className="pointer-events-none absolute inset-0 flex items-end justify-end bg-gradient-to-t from-foreground/30 to-transparent p-1.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-background/85 text-foreground shadow-sm">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
            aria-hidden
          >
            <path d="M6 2.5H2.5v3.5M10 2.5h3.5v3.5M6 13.5H2.5V10M10 13.5h3.5V10" />
          </svg>
        </span>
      </span>
    </button>
  );
}

function FileChip({ a, onClick }: { a: MessageAttachment; onClick: () => void }) {
  const { t } = useTranslation();
  const size = formatBytes(a.filesize);
  const label = fileLabel(a.filename, a.type);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group inline-flex w-full max-w-[18rem] items-center gap-2.5 rounded-xl bg-card/70 px-2.5 py-2 text-start',
        'ring-1 ring-foreground/[0.06] shadow-sm shadow-foreground/[0.04]',
        'transition-[box-shadow,background-color] duration-fast ease-out',
        'hover:bg-card hover:shadow-md hover:shadow-foreground/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
    >
      <FileGlyph type={a.type} filename={a.filename} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">
          {a.filename ?? t('conversation.attachment', { defaultValue: 'Attachment' })}
        </span>
        <span className="block text-2xs tabular-nums text-muted-foreground">
          {label}
          {size && ` · ${size}`}
        </span>
      </span>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-fast group-hover:bg-secondary group-hover:text-foreground">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden
        >
          <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13h10" />
        </svg>
      </span>
    </button>
  );
}
