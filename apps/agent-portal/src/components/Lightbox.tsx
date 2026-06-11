import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@yiji/ui';
import { formatBytes } from '../lib/files.js';

/**
 * Full-screen image preview. Rendered in a portal above everything, dismissed
 * by Esc, backdrop click, or the close button. The image itself is an already-
 * fetched object URL (private assets need the agent token), so this component
 * stays presentational.
 */
export function Lightbox({
  url,
  filename,
  filesize,
  onDownload,
  onClose,
}: {
  url: string;
  filename: string | null;
  filesize?: number | null;
  onDownload?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  // Keep the latest onClose without re-subscribing the listener every render
  // (the parent passes a fresh arrow each time), so Escape can never race a
  // re-render and end up bound to a stale/removed handler.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    // Capture phase so nothing downstream (composer, shortcuts) can swallow Esc.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    // Lock background scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, []);

  const size = formatBytes(filesize);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return createPortal(
    // Any click that isn't on the image (or an action button) dismisses — far
    // more reliable than matching e.target===e.currentTarget, which left the
    // top bar and the image's letterbox margins as dead zones that ignored
    // clicks (so the first attempt to close often did nothing).
    <div
      role="dialog"
      aria-modal="true"
      aria-label={filename ?? t('conversation.attachment', { defaultValue: 'Attachment' })}
      onClick={onClose}
      className="fixed inset-0 z-[80] flex flex-col bg-foreground/80 backdrop-blur-md animate-fade-in"
    >
      {/* Top bar: name + size, actions */}
      <div className="flex items-center gap-3 px-4 py-3 text-background">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {filename ?? t('conversation.attachment', { defaultValue: 'Attachment' })}
          </p>
          {size && <p className="text-2xs text-background/60 tabular-nums">{size}</p>}
        </div>
        {onDownload && (
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              onDownload();
            }}
            aria-label={t('conversation.download', { defaultValue: 'Download' })}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-background/15 px-3.5 text-sm font-medium text-background transition-colors duration-fast ease-out hover:bg-background/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/50"
          >
            <DownloadIcon />
            {t('conversation.download', { defaultValue: 'Download' })}
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            stop(e);
            onClose();
          }}
          aria-label={t('actions.close', { ns: 'common', defaultValue: 'Close' })}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-background/15 text-background transition-colors duration-fast ease-out hover:bg-background/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/50"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Image stage — clicking the image keeps it open; clicking around it (or
          anywhere else) bubbles to the backdrop and closes. */}
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0">
        <img
          src={url}
          alt={filename ?? ''}
          onClick={stop}
          className={cn(
            'max-h-full max-w-full rounded-lg object-contain shadow-2xl shadow-foreground/40',
            'motion-safe:animate-scale-in',
          )}
        />
      </div>
    </div>,
    document.body,
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13h10" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}
