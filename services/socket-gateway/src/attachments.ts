/**
 * Attachment validation (spec §7 file attachments, §17 attachment validation,
 * FR-034). Message attachments arrive as Directus file UUIDs; before a message
 * is persisted the gateway resolves each file's metadata and enforces a MIME
 * allow-list + a maximum size. Files that don't exist, exceed the size cap, or
 * carry a disallowed type are rejected.
 *
 * Pure functions — the Directus lookup is injected by the caller so this is
 * unit-testable without a live Directus.
 */

export interface AttachmentMeta {
  id: string;
  type: string | null;
  filesize: number | null;
}

export interface AttachmentPolicy {
  maxBytes: number;
  /** Lower-cased allowed MIME types. Empty array = allow none. */
  allowedMime: string[];
}

export interface AttachmentValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Sanitize a client-supplied attachment filename before it is stored and later
 * offered to an agent as a download name. Takes the basename only (no path
 * traversal), strips ASCII control characters and Unicode bidi-override
 * codepoints (which can disguise the real extension — e.g. an RTL override that
 * makes "photo<U+202E>gpj.exe" render as "photoexe.jpg"), caps the length, and
 * falls back to "upload" when nothing usable remains.
 *
 * Filtering is done by code point (not a literal regex) so no raw control
 * characters live in this source file.
 */
export function sanitizeFilename(input: unknown): string {
  if (typeof input !== 'string') return 'upload';
  const base = input.split(/[/\\]/).pop() ?? '';
  let cleaned = '';
  for (const ch of base) {
    const c = ch.codePointAt(0) ?? 0;
    const isControl = c < 0x20 || c === 0x7f;
    const isBidi = (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    if (!isControl && !isBidi) cleaned += ch;
  }
  const safe = cleaned.trim().replace(/^\.+/, '').slice(0, 200);
  return safe.length > 0 ? safe : 'upload';
}

/**
 * Decode an `attachment:upload` payload's `content` into a Buffer. Socket.IO
 * may deliver the bytes three ways: an `ArrayBuffer`, a Node `Buffer` /
 * typed-array view (websocket transport), or a base64 string (polling
 * transport). Returns null when there is no usable content.
 *
 * For an `ArrayBufferView` we copy ONLY the view's window — `byteOffset` +
 * `byteLength`. Socket.IO hands us a `Buffer` that is frequently a *slice* of a
 * larger pooled `ArrayBuffer`, so reading `.buffer` wholesale would capture the
 * wrong bytes and the wrong length, silently corrupting the uploaded file.
 */
export function decodeUploadContent(content: unknown): Buffer | null {
  let buf: Buffer | null = null;
  if (content instanceof ArrayBuffer) {
    buf = Buffer.from(content);
  } else if (ArrayBuffer.isView(content)) {
    buf = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  } else if (typeof content === 'string') {
    buf = Buffer.from(content, 'base64');
  }
  return buf && buf.length > 0 ? buf : null;
}

/** Build a policy from comma-separated env config. */
export function parseAttachmentPolicy(maxBytes: number, allowedMimeCsv: string): AttachmentPolicy {
  return {
    maxBytes,
    allowedMime: allowedMimeCsv
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * Validate the requested attachment ids against resolved metadata + policy.
 * Every requested id must resolve to a real file that passes MIME + size.
 */
export function validateAttachments(
  requestedIds: string[],
  metas: AttachmentMeta[],
  policy: AttachmentPolicy,
): AttachmentValidationResult {
  if (requestedIds.length === 0) return { ok: true };

  const byId = new Map(metas.map((m) => [m.id, m]));
  for (const id of requestedIds) {
    const meta = byId.get(id);
    if (!meta) return { ok: false, reason: `attachment ${id} not found` };

    const type = (meta.type ?? '').toLowerCase();
    if (!type || !policy.allowedMime.includes(type)) {
      return { ok: false, reason: `attachment type "${meta.type ?? 'unknown'}" not allowed` };
    }

    const size = meta.filesize ?? null;
    if (size === null) return { ok: false, reason: `attachment ${id} has unknown size` };
    if (size > policy.maxBytes) {
      return {
        ok: false,
        reason: `attachment ${id} is ${size} bytes, over the ${policy.maxBytes}-byte limit`,
      };
    }
  }
  return { ok: true };
}
