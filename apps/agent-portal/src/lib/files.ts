/**
 * File-type helpers for attachment UI. Maps a MIME type (and filename fallback)
 * to a coarse "kind" so the UI can show a type-appropriate glyph + tone, and
 * formats byte counts for display.
 */

export type FileKind =
  | 'image'
  | 'pdf'
  | 'sheet'
  | 'doc'
  | 'text'
  | 'archive'
  | 'audio'
  | 'video'
  | 'file';

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  csv: 'sheet',
  xls: 'sheet',
  xlsx: 'sheet',
  numbers: 'sheet',
  doc: 'doc',
  docx: 'doc',
  rtf: 'doc',
  pages: 'doc',
  txt: 'text',
  md: 'text',
  log: 'text',
  json: 'text',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
};

/** Classify an attachment from its MIME type, falling back to the extension. */
export function fileKind(type: string | null | undefined, filename?: string | null): FileKind {
  const mime = (type ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('spreadsheet') || mime === 'text/csv') return 'sheet';
  if (mime.includes('word') || mime.includes('document')) return 'doc';
  if (mime.startsWith('text/')) return 'text';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) return 'archive';

  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
  return 'file';
}

export function isImage(type: string | null | undefined, filename?: string | null): boolean {
  return fileKind(type, filename) === 'image';
}

/** Short uppercase type label for a chip subtitle, e.g. "PDF", "DOCX", "Image". */
export function fileLabel(filename?: string | null, type?: string | null): string {
  const ext = filename?.includes('.') ? filename.split('.').pop() : undefined;
  if (ext && ext.length <= 5) return ext.toUpperCase();
  const k = fileKind(type, filename);
  return k === 'file' ? 'File' : k.charAt(0).toUpperCase() + k.slice(1);
}

/**
 * Attachment policy — MIRRORS the socket-gateway's server-side limits
 * (`ATTACHMENT_ALLOWED_MIME` / `ATTACHMENT_MAX_BYTES`, defaults in
 * services/socket-gateway/src/config.ts). The gateway is the source of truth
 * and re-validates every upload; this client copy exists only to give instant,
 * specific feedback (and an `accept` filter on the picker) instead of letting
 * the user wait through a 20s round-trip for a file the gateway will reject.
 * Keep this list in sync if the gateway env changes.
 */
export const ALLOWED_ATTACHMENT_MIME = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
] as const;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/** `accept` attribute for the file picker, so the OS dialog only offers
 *  uploadable types (extensions + MIME for broad browser support). */
export const ATTACHMENT_ACCEPT =
  '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,' + ALLOWED_ATTACHMENT_MIME.join(',');

export type AttachmentRejection = 'type' | 'size';

/**
 * Validate a file against the gateway policy BEFORE uploading. Returns null if
 * the file is acceptable, or a reason code the caller maps to a localized
 * message. Empty MIME falls back to the extension (some OSes report '' for
 * .txt/.csv); anything we can't positively place is rejected as 'type'.
 */
export function validateAttachment(file: File): AttachmentRejection | null {
  if (file.size > MAX_ATTACHMENT_BYTES) return 'size';
  const mime = (file.type || '').toLowerCase();
  if (mime) {
    return (ALLOWED_ATTACHMENT_MIME as readonly string[]).includes(mime) ? null : 'type';
  }
  // No MIME from the browser — fall back to extension for the allowed set.
  const ext = file.name.split('.').pop()?.toLowerCase();
  const okByExt = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt'];
  return ext && okByExt.includes(ext) ? null : 'type';
}

/** Human-readable byte size, e.g. 1536 → "1.5 KB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val >= 10 || Number.isInteger(val) ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}
