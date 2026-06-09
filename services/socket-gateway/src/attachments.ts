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
