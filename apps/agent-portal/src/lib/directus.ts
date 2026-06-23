import { createAuthClient } from '@yiji/shared-config';

export const DIRECTUS_URL = import.meta.env.VITE_DIRECTUS_URL ?? 'http://localhost:8055';

/** Download/preview URL for a Directus file id (via the assets endpoint). */
export function assetUrl(fileId: string): string {
  return `${DIRECTUS_URL}/assets/${fileId}`;
}

/**
 * Download an attachment. Directus files are private, so a bare <a>/<img> would
 * 403 — we fetch with the agent's bearer token and hand the browser a blob URL.
 */
export async function downloadAsset(fileId: string, filename?: string): Promise<void> {
  const token = await auth.getToken();
  const res = await fetch(`${assetUrl(fileId)}?download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`asset_download_${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// H-2: no storage arg → in-memory access token only; the refresh token lives in
// an httpOnly cookie set by Directus (unreadable by JS).
export const auth = createAuthClient({ url: DIRECTUS_URL });

/** Authenticated Directus client for reads (conversations, messages, ...). */
export const directus = auth.client;
